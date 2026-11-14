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
