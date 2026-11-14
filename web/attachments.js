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
