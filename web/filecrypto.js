// Locking files for chats, in the browser. Nothing in here touches the page or the network,
// so it can be tested with Node (tests/filecrypto.test.mjs). The pieces are kept by backend/blobs.py.
//
// A file is cut into pieces of 4 MB and every piece is locked on its own with AES-GCM, all under
// one random key made for this one file. The piece number and "is this the last piece" are part
// of what GCM checks, so nobody can reorder the pieces, cut the end off or slip in a piece from
// another file. The key, the name and the type never leave the encrypted chat message: the server
// only ever sees a random id and a pile of scrambled bytes.

const FC_CHUNK = 4 * 1024 * 1024; // the same number as CHUNK in backend/blobs.py
const FC_TAG = 16; // what AES-GCM adds to every piece
const FC_MAX_BYTES = 2048 * 1024 * 1024; // like a WhatsApp document, the same as MAX_FILE on the server
const FC_MEM_SAVE_MAX = 1024 * 1024 * 1024; // the most a browser without a save dialog is asked to hold in memory

function fcB64(bytes) {
  // in slices, because spreading a big array into fromCharCode blows the stack
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fcUnb64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// how many pieces a file of this size is cut into (an empty file is one empty piece)
function fcCount(size) {
  return Math.max(1, Math.ceil(size / FC_CHUNK));
}

// how big all the locked pieces are together
function fcCipherSize(size) {
  return size + fcCount(size) * FC_TAG;
}

// the key for one file, plus the first 8 bytes of every piece's nonce (the other 4 are the piece number)
function fcNewSecret() {
  return { key: crypto.getRandomValues(new Uint8Array(32)), prefix: crypto.getRandomValues(new Uint8Array(8)) };
}

function fcImport(raw) {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function fcIv(prefix, index) {
  const iv = new Uint8Array(12);
  iv.set(prefix, 0);
  new DataView(iv.buffer).setUint32(8, index);
  return iv;
}

function fcAad(index, last) {
  const aad = new Uint8Array(5);
  new DataView(aad.buffer).setUint32(0, index);
  aad[4] = last ? 1 : 0;
  return aad;
}

async function fcSeal(key, prefix, index, last, plain) {
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: fcIv(prefix, index), additionalData: fcAad(index, last) }, key, plain);
  return new Uint8Array(sealed);
}

// throws if the piece was changed, is out of place, or belongs to another file
async function fcOpen(key, prefix, index, last, sealed) {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fcIv(prefix, index), additionalData: fcAad(index, last) }, key, sealed);
  return new Uint8Array(plain);
}


// ---------- what goes in the chat message ----------
// The message says where the file is and how to open it. It is the chat message that is
// end-to-end encrypted, so the key and the name are only ever seen by the people in the chat.

const FC_MAX_NAME = 120;
const FC_VOICE_MAX_SECONDS = 5 * 60;
const FC_PREFIX = "\u0001file:"; // a chat message that starts like this is a file, not text

// only these are shown inside the chat, everything else (svg and html too) is just a download
const FC_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const FC_VIDEO_TYPES = ["video/mp4", "video/webm", "video/ogg", "video/quicktime"];
const FC_AUDIO_TYPES = ["audio/webm", "audio/mpeg", "audio/ogg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/aac", "audio/flac", "audio/x-m4a"];

const FC_ID_RE = /^[0-9a-f]{32}$/;
const FC_TYPE_RE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;

function fcCleanType(type) {
  const t = String(type || "").split(";")[0].trim().toLowerCase();
  return t.length <= 100 && FC_TYPE_RE.test(t) ? t : "application/octet-stream";
}

// a name that's safe to show and to save under: no folders, no control or direction-flipping characters
function fcCleanName(name) {
  let n = String(name || "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\\/:*?"<>|]/g, "_")
    .replace(/^[.\s]+/, "")
    .trim();
  if (!n) return "file";
  if (n.length > FC_MAX_NAME) {
    const dot = n.lastIndexOf(".");
    const ext = dot > 0 && n.length - dot <= 12 ? n.slice(dot) : "";
    n = n.slice(0, FC_MAX_NAME - ext.length) + ext;
  }
  return n;
}

function fcDescriptor({ id, secret, size, name, type, kind, dur }) {
  const d = {
    v: 1,
    id,
    key: fcB64(secret.key),
    iv: fcB64(secret.prefix),
    size,
    chunks: fcCount(size),
    name: fcCleanName(name),
    type: fcCleanType(type),
    kind: kind === "voice" ? "voice" : "file",
  };
  if (d.kind === "voice") d.dur = Math.min(FC_VOICE_MAX_SECONDS, Math.max(0, Math.round(dur || 0)));
  return d;
}

function fcWire(desc) {
  return FC_PREFIX + JSON.stringify(desc);
}

// The other side of fcWire. A message from somebody else is not to be trusted, so every field
// is checked and the result is built again from the checked parts. Returns null for anything
// that isn't a well formed file message (it is then shown as plain text).
function fcParse(text) {
  if (typeof text !== "string" || !text.startsWith(FC_PREFIX)) return null;
  let d;
  try {
    d = JSON.parse(text.slice(FC_PREFIX.length));
  } catch {
    return null;
  }
  if (!d || typeof d !== "object" || d.v !== 1) return null;
  if (typeof d.id !== "string" || !FC_ID_RE.test(d.id)) return null;
  if (!Number.isSafeInteger(d.size) || d.size < 0 || d.size > FC_MAX_BYTES) return null;
  if (d.chunks !== fcCount(d.size)) return null;
  if (typeof d.key !== "string" || typeof d.iv !== "string") return null;
  try {
    if (fcUnb64(d.key).length !== 32 || fcUnb64(d.iv).length !== 8) return null;
  } catch {
    return null;
  }
  if (typeof d.name !== "string" || !d.name || d.name.length > FC_MAX_NAME) return null;
  if (typeof d.type !== "string" || d.type.length > 100 || !FC_TYPE_RE.test(d.type)) return null;
  if (d.kind !== "file" && d.kind !== "voice") return null;
  const out = { v: 1, id: d.id, key: d.key, iv: d.iv, size: d.size, chunks: d.chunks, name: fcCleanName(d.name), type: d.type, kind: d.kind };
  if (d.kind === "voice") {
    if (!Number.isFinite(d.dur) || d.dur < 0 || d.dur > FC_VOICE_MAX_SECONDS) return null;
    out.dur = Math.round(d.dur);
  }
  return out;
}

// how a file is shown: "image", "video", "audio", "voice" or just "file"
function fcMediaKind(d) {
  if (d.kind === "voice" && FC_AUDIO_TYPES.includes(d.type)) return "voice";
  if (FC_IMAGE_TYPES.includes(d.type)) return "image";
  if (FC_VIDEO_TYPES.includes(d.type)) return "video";
  if (FC_AUDIO_TYPES.includes(d.type)) return "audio";
  return "file";
}

function fcHumanSize(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return (i === 0 || n >= 10 ? Math.round(n) : Math.round(n * 10) / 10) + " " + units[i];
}

// Can this browser save a file this big? Browsers that can ask where to save (Chrome, Edge) write it to
// disk piece by piece. The others have to hold the whole file in memory first.
function fcCanSaveHere(size, canPickFile) {
  return Boolean(canPickFile) || size <= FC_MEM_SAVE_MAX;
}

function fcClock(seconds) {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}
