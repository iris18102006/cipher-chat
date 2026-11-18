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
  toobig: "this file is too big to save in this browser right now, reload the page and try again, or open cipher-chat in Chrome or Edge",
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
async function uploadAttachment(file, kind, dur, onProgress, stop) {
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
  try {
    for (let i = 0; i < pieces; i++) {
      if (stop && stop.stop) {
        const err = new Error("cancelled");
        err.code = "cancelled";
        throw err;
      }
      const plain = new Uint8Array(await file.slice(i * FC_CHUNK, (i + 1) * FC_CHUNK).arrayBuffer());
      const sealed = await fcSeal(key, secret.prefix, i, i === pieces - 1, plain);
      await attPut("/api/blobs/" + made.id + "/pieces/" + i, sealed);
      if (onProgress) onProgress((i + 1) / pieces);
    }
    await api("/api/blobs/" + made.id + "/complete", { method: "POST" });
  } catch (ex) {
    // don't leave half a file on the server
    api("/api/blobs/" + made.id, { method: "DELETE" }).catch(() => {});
    throw ex;
  }
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


// Streams a file to the browser's download through the helper in sw.js (Firefox, Safari), piece
// by piece. Returns false if the helper isn't there, before anything was sent, so the caller can
// fall back to the Blob way.
async function attStreamSave(desc, onProgress) {
  let out = null;
  try {
    out = await ssOpen(desc.name, desc.size);
  } catch {
    return false;
  }
  try {
    await attOpenPieces(desc, (plain) => out.write(plain), onProgress);
    out.close();
  } catch (ex) {
    out.abort();
    if (ex && ex.message === "cancelled") return true; // they cancelled in the browser's downloads
    throw ex;
  }
  return true;
}

// Saves a file under its own name. Big files in Chrome and Edge are written straight to disk
// piece by piece, so a 2 GB file never has to fit in memory. Firefox and Safari stream it through
// the download helper (sw.js) when they can. Anything else keeps it in a Blob.
async function attSave(desc, onProgress) {
  if (!fcCanSaveHere(desc.size, window.showSaveFilePicker)) throw attFail("toobig");
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


// videos, songs and voice messages: a button first, the player after it has been opened
function attPlayer(box, desc, kind) {
  const mount = (url, autoplay) => {
    const media = el(kind === "video" ? "video" : "audio");
    media.controls = true;
    media.preload = "metadata";
    media.src = url;
    box.replaceChildren(...(kind === "voice" ? [] : [attNameLine(desc)]), media);
    if (autoplay) media.play().catch(() => {});
  };
  if (attCache.has(desc.id)) return mount(attCache.get(desc.id), false);
  const label = kind === "voice" ? "\u{1f3a4} voice message " + fcClock(desc.dur) : "\u25b6 play " + kind + " (" + fcHumanSize(desc.size) + ")";
  box.append(attLoadButton(label, async (progress) => mount(await attLoadUrl(desc, progress), true)));
}


function attIcon(desc) {
  const name = desc.name.toLowerCase();
  if (desc.type.startsWith("image/")) return "\u{1f5bc}\u{fe0f}";
  if (desc.type.startsWith("video/")) return "\u{1f3ac}";
  if (desc.type.startsWith("audio/")) return "\u{1f3b5}";
  if (desc.type === "application/pdf") return "\u{1f4d5}";
  if (/\.(zip|rar|7z|tar|gz)$/.test(name)) return "\u{1f5dc}\u{fe0f}";
  return "\u{1f4c4}";
}

// everything that isn't shown in the chat: a card with a download button
function attFile(box, desc, tooBigToPlay) {
  const info = el("div", "att-info");
  info.append(el("div", "att-title", desc.name), el("div", "att-note", fcHumanSize(desc.size) + (tooBigToPlay ? " \u00b7 too big to play here, download it" : "")));
  box.append(el("div", "att-icon", attIcon(desc)), info, attLoadButton("Download", (progress) => attSave(desc, progress)));
}

function attachmentNode(desc) {
  const kind = fcMediaKind(desc);
  const playable = desc.size <= ATT_PLAY_MAX;
  const box = el("div", "att att-" + (kind === "image" || playable ? kind : "file"));
  if (kind === "image") attImage(box, desc);
  else if (kind !== "file" && playable) attPlayer(box, desc, kind);
  else attFile(box, desc, kind !== "file");
  return box;
}

// what goes in a message bubble: a file if the message is one, otherwise the text
function messageBody(m) {
  const desc = m.failed ? null : fcParse(m.text);
  return desc ? attachmentNode(desc) : el("div", "text", m.text);
}


// ---------- sending ----------

function attTarget() {
  return { peer: state.open, group: state.openGroup };
}

// sends a ready-made message (like a file) to one chat, whichever kind of chat it is
function sendWire(target, text) {
  return target.group != null ? sendGroupText(target.group, text) : sendDirectText(target.peer, text);
}

function attCanSend() {
  return (state.open || state.openGroup != null) && !$("msg").disabled;
}

// the buttons follow the text box: locked whenever you can't write in this chat
function attSync() {
  for (const id of ["attach", "mic"]) $(id).disabled = $("msg").disabled;
}

let attBusy = false;
const attStop = { stop: false }; // turns true when you press Cancel

function attShowStatus(text, fraction) {
  $("att-status").hidden = text === null;
  if (text === null) return;
  $("att-status-text").textContent = text;
  $("att-progress").value = Math.round((fraction || 0) * 100);
}

// Sends files one after another, each as a message of its own. They go to the chat that was
// open when you picked them, even if you click on another chat while they upload.
async function sendFiles(files, kind, dur, target) {
  if (!attCanSend()) {
    toast("You can't send files here right now.");
    return;
  }
  if (attBusy) {
    toast("Hold on, the last file is still going.");
    return;
  }
  target = target || attTarget();
  attBusy = true;
  try {
    for (const file of files) {
      attShowStatus("Sending " + file.name + "...", 0);
      attStop.stop = false;
      try {
        const desc = await uploadAttachment(file, kind, dur, (p) => attShowStatus("Sending " + file.name + "...", p), attStop);
        // keep what we sent, so our own picture or voice message shows up at once
        if (fcMediaKind(desc) !== "file" && file.size <= ATT_PLAY_MAX) {
          attCache.set(desc.id, URL.createObjectURL(new Blob([file], { type: desc.type })));
        }
        if (!(await sendWire(target, fcWire(desc)))) {
          api("/api/blobs/" + desc.id, { method: "DELETE" }).catch(() => {});
          return;
        }
      } catch (ex) {
        if (ex.code !== "cancelled") toast(attWhy(ex, "Couldn't send " + file.name + ", try again."));
        return;
      }
    }
  } finally {
    attBusy = false;
    attShowStatus(null);
  }
}

$("attach").onclick = () => $("attach-input").click();
$("att-cancel").onclick = () => (attStop.stop = true);
$("attach-input").onchange = () => {
  const files = [...$("attach-input").files];
  $("attach-input").value = "";
  if (files.length) sendFiles(files, "file");
};


// ---------- drag and drop, paste ----------

const attLog = $("log");

attLog.addEventListener("dragover", (e) => {
  if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) {
    e.preventDefault(); // that's what allows dropping here
    attLog.classList.add("drop");
  }
});

attLog.addEventListener("dragleave", (e) => {
  if (!attLog.contains(e.relatedTarget)) attLog.classList.remove("drop");
});

attLog.addEventListener("drop", (e) => {
  e.preventDefault();
  attLog.classList.remove("drop");
  const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
  if (files.length) sendFiles(files, "file");
});

// a picture or file on the clipboard (a screenshot, say) is sent instead of typed in
$("msg").addEventListener("paste", (e) => {
  const files = [...((e.clipboardData && e.clipboardData.files) || [])];
  if (!files.length) return;
  e.preventDefault();
  sendFiles(files, "file");
});


// ---------- voice messages ----------
// Recorded in the browser (MediaRecorder) and then sent exactly like any other file.

const REC_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
let rec = null; // the recording that's going on: { recorder, stream, chunks, started, target, send, timer }
let recStarting = false; // waiting for the browser to ask about the microphone

// while you record, the bar takes the place of the text box
function recShow(on) {
  $("rec-bar").hidden = !on;
  $("composer").hidden = on;
}

function attTargetName(target) {
  if (target.group != null) {
    const g = state.groups.get(target.group);
    return g ? g.name : "the group";
  }
  const c = state.contacts.get(target.peer);
  return c ? shownName(c) : target.peer;
}

async function recStart() {
  if (rec || recStarting) return;
  if (!attCanSend()) {
    toast("You can't send a voice message here right now.");
    return;
  }
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    toast("Your browser can't record audio here.");
    return;
  }
  recStarting = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast("Couldn't use the microphone. Allow it in your browser and try again.");
    return;
  } finally {
    recStarting = false;
  }
  const type = REC_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
  const r = {
    recorder: new MediaRecorder(stream, type ? { mimeType: type } : undefined),
    stream,
    chunks: [],
    started: Date.now(),
    target: attTarget(),
    send: false,
    timer: null,
  };
  r.recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) r.chunks.push(e.data);
  };
  r.recorder.onstop = () => recDone(r);
  r.recorder.start(1000);
  rec = r;
  $("rec-who").textContent = "Recording to " + attTargetName(r.target);
  $("rec-time").textContent = "0:00";
  recShow(true);
  r.timer = setInterval(() => {
    const secs = Math.floor((Date.now() - r.started) / 1000);
    $("rec-time").textContent = fcClock(secs);
    if (secs >= FC_VOICE_MAX_SECONDS) {
      toast("That's the 5 minute limit, sending your voice message.");
      recStop(true);
    }
  }, 250);
}

// send = true keeps the recording and sends it, false throws it away
function recStop(send) {
  if (!rec) return;
  rec.send = send;
  if (rec.recorder.state !== "inactive") rec.recorder.stop();
  else recDone(rec);
}

function recDone(r) {
  clearInterval(r.timer);
  if (rec === r) rec = null;
  recShow(false);
  r.stream.getTracks().forEach((t) => t.stop()); // turns the microphone light off
  if (!r.send) return;
  const secs = Math.min(FC_VOICE_MAX_SECONDS, Math.round((Date.now() - r.started) / 1000));
  if (!r.chunks.length || secs < 1) {
    toast("That was too short to send.");
    return;
  }
  const type = fcCleanType(r.recorder.mimeType || "audio/webm");
  const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  sendFiles([new File(r.chunks, "voice-" + stamp + "." + ext, { type })], "voice", secs, r.target);
}

$("mic").onclick = recStart;
$("rec-cancel").onclick = () => recStop(false);
$("rec-send").onclick = () => recStop(true);

// Escape throws the recording away, and so does leaving the page
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && rec) recStop(false);
});
window.addEventListener("pagehide", () => recStop(false));
