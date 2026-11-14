// Sending and opening files in chats: the browser side of backend/blobs.py.
// Loaded after filecrypto.js (the locking) and app.js (api, el, toast, state, whyFailed).
//
// Everything about a file except its random id travels inside the encrypted chat message, so
// nothing here trusts the server: every piece is checked as it is opened.

const ATT_AUTO_IMAGE_MAX = 10 * 1024 * 1024; // pictures up to this size show up by themselves
const ATT_PLAY_MAX = 200 * 1024 * 1024; // a video or a song has to fit in memory to play, bigger ones are downloads
const ATT_DISK_MIN = 64 * 1024 * 1024; // bigger downloads go straight to disk when the browser can

const ATT_ERRORS = {
  gone: "this file isn't on the server any more (files are only kept for a while)",
  corrupt: "this file was damaged or changed on the way, so it wasn't opened",
  failed: "couldn't download this file, try again",
};

function attFail(code) {
  const err = new Error(ATT_ERRORS[code]);
  err.code = code;
  return err;
}

// the reason to show: ours, the server's own, or a plain fallback
function attWhy(ex, fallback) {
  return ex && ex.code ? ex.message : whyFailed(ex, fallback);
}

// one raw upload, tried again a couple of times if the network hiccups
async function attPut(path, body) {
  let last;
  for (let tries = 0; tries < 3; tries++) {
    try {
      return await api(path, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body });
    } catch (ex) {
      last = ex;
      if (ex.status && ex.status < 500) throw ex; // the server said no, asking again won't change that
      await new Promise((resolve) => setTimeout(resolve, 500 * (tries + 1)));
    }
  }
  throw last;
}

// Locks a file and uploads it piece by piece. Gives back what goes in the chat message.
async function uploadAttachment(file, kind, dur, onProgress) {
  if (file.size > FC_MAX_BYTES) {
    const err = new Error("that file is too big (max " + fcHumanSize(FC_MAX_BYTES) + ")");
    err.code = "toobig";
    throw err;
  }
  const pieces = fcCount(file.size);
  const made = await api("/api/blobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pieces, size: fcCipherSize(file.size) }),
  });
  const secret = fcNewSecret();
  const key = await fcImport(secret.key);
  for (let i = 0; i < pieces; i++) {
    const plain = new Uint8Array(await file.slice(i * FC_CHUNK, (i + 1) * FC_CHUNK).arrayBuffer());
    const sealed = await fcSeal(key, secret.prefix, i, i === pieces - 1, plain);
    await attPut("/api/blobs/" + made.id + "/pieces/" + i, sealed);
    if (onProgress) onProgress((i + 1) / pieces);
  }
  await api("/api/blobs/" + made.id + "/complete", { method: "POST" });
  return fcDescriptor({ id: made.id, secret, size: file.size, name: file.name, type: file.type, kind, dur });
}


// ---------- opening ----------

const attCache = new Map(); // file id -> blob: address of the opened file, for pictures, videos and sounds
const attPending = new Map(); // file id -> an open that is already running

// Fetches and opens a file's pieces one after another. `each(plain, index)` gets every piece.
async function attOpenPieces(desc, each, onProgress) {
  const key = await fcImport(fcUnb64(desc.key));
  const prefix = fcUnb64(desc.iv);
  let total = 0;
  for (let i = 0; i < desc.chunks; i++) {
    let res;
    try {
      res = await fetch("/api/blobs/" + desc.id + "/pieces/" + i);
    } catch {
      throw attFail("failed");
    }
    if (res.status === 401) {
      location.href = "/login.html";
      throw attFail("failed");
    }
    if (res.status === 404) throw attFail("gone");
    if (!res.ok) throw attFail("failed");
    let plain;
    try {
      plain = await fcOpen(key, prefix, i, i === desc.chunks - 1, new Uint8Array(await res.arrayBuffer()));
    } catch {
      throw attFail("corrupt");
    }
    total += plain.length;
    await each(plain, i);
    if (onProgress) onProgress((i + 1) / desc.chunks);
  }
  if (total !== desc.size) throw attFail("corrupt");
}

// Opens a picture, video or sound for showing in the chat, once: the result is kept.
async function attLoadUrl(desc, onProgress) {
  if (attCache.has(desc.id)) return attCache.get(desc.id);
  if (attPending.has(desc.id)) return attPending.get(desc.id);
  const job = (async () => {
    const parts = [];
    await attOpenPieces(desc, (plain) => parts.push(new Blob([plain])), onProgress);
    const url = URL.createObjectURL(new Blob(parts, { type: desc.type }));
    attCache.set(desc.id, url);
    return url;
  })();
  attPending.set(desc.id, job);
  try {
    return await job;
  } finally {
    attPending.delete(desc.id);
  }
}


// Saves a file under its own name. Big files in Chrome and Edge are written straight to disk
// piece by piece, so a 2 GB file never has to fit in memory. Other browsers keep it in a Blob.
async function attSave(desc, onProgress) {
  if (window.showSaveFilePicker && desc.size > ATT_DISK_MIN) {
    let handle = null;
    try {
      handle = await window.showSaveFilePicker({ suggestedName: desc.name });
    } catch (ex) {
      if (ex && ex.name === "AbortError") return; // they changed their mind
    }
    if (handle) {
      const out = await handle.createWritable();
      try {
        await attOpenPieces(desc, (plain) => out.write(plain), onProgress);
        await out.close();
      } catch (ex) {
        await out.abort().catch(() => {});
        throw ex;
      }
      return;
    }
  }
  const parts = [];
  await attOpenPieces(desc, (plain) => parts.push(new Blob([plain])), onProgress);
  // always saved as an anonymous download, never opened as a page, whatever type the sender said
  const url = URL.createObjectURL(new Blob(parts, { type: "application/octet-stream" }));
  const link = el("a");
  link.href = url;
  link.download = desc.name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}


// ---------- showing files in the chat ----------

function attNameLine(desc) {
  return el("div", "att-name", desc.name + " \u00b7 " + fcHumanSize(desc.size));
}

// A button that opens something, shows how far it got and says why when it fails.
// `run(progress)` does the work and puts the result on the page itself.
function attLoadButton(label, run) {
  const wrap = el("div", "att-action");
  const btn = el("button", "att-btn", label);
  btn.type = "button";
  const note = el("span", "att-note");
  btn.onclick = async () => {
    btn.disabled = true;
    note.classList.remove("bad");
    note.textContent = "";
    try {
      await run((p) => (note.textContent = Math.round(p * 100) + "%"));
      note.textContent = "";
    } catch (ex) {
      note.textContent = attWhy(ex, ATT_ERRORS.failed);
      note.classList.add("bad");
    }
    btn.disabled = false;
  };
  wrap.append(btn, note);
  return wrap;
}

function attImage(box, desc) {
  const show = (url) => {
    const img = el("img");
    img.src = url;
    img.alt = desc.name;
    img.draggable = false;
    img.title = "click to open";
    img.onclick = () => window.open(url, "_blank", "noopener");
    box.replaceChildren(img, attNameLine(desc));
  };
  const manual = () => attLoadButton("Show picture", async (progress) => show(await attLoadUrl(desc, progress)));
  if (attCache.has(desc.id)) {
    show(attCache.get(desc.id));
  } else if (desc.size <= ATT_AUTO_IMAGE_MAX) {
    box.append(el("div", "att-note", "loading picture..."));
    attLoadUrl(desc)
      .then(show)
      .catch((ex) => {
        const why = el("div", "att-note bad", attWhy(ex, ATT_ERRORS.failed));
        box.replaceChildren(attNameLine(desc), why, manual());
      });
  } else {
    box.append(attNameLine(desc), manual());
  }
}
