// All the crypto lives here. The private key is generated in the browser as
// non-extractable and only ever sits in IndexedDB, it is never sent anywhere.

const DB_NAME = "cipher-chat";
const STORE = "keys";
const ECDH = { name: "ECDH", namedCurve: "P-256" };

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGet(db, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbSet(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// One identity per username, so two accounts in the same browser don't share
// (and impersonate) each other's key.
async function loadOrCreateIdentity(username) {
  const db = await openDB();
  const slot = "identity:" + username;
  let keys = await dbGet(db, slot);
  if (!keys) {
    keys = await crypto.subtle.generateKey(ECDH, false, ["deriveKey"]);
    await dbSet(db, slot, keys);
  }
  return keys;
}

function b64(buf) {
  // chunked, because spreading a big buffer into fromCharCode blows the stack
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function unb64(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function exportPub(publicKey) {
  return b64(await crypto.subtle.exportKey("raw", publicKey));
}

function importPub(s) {
  return crypto.subtle.importKey("raw", unb64(s), ECDH, true, []);
}

// "a1b2 c3d4 ..." from the SHA-256 of the raw public key (given as base64)
async function fingerprintOf(pubB64) {
  const hash = await crypto.subtle.digest("SHA-256", unb64(pubB64));
  const hex = [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 32).match(/.{4}/g).join(" ");
}

// the HKDF "info" keeps keys for different jobs apart, so the key that locks a
// 1:1 chat is never the same key that wraps a group key
const CHAT_INFO = "cipher-chat v1";
const GROUP_WRAP_INFO = "cipher-chat group-key v1";

async function deriveSharedKey(privateKey, peerPublicKey, info = CHAT_INFO) {
  const hkdfBase = await crypto.subtle.deriveKey(
    { name: "ECDH", public: peerPublicKey },
    privateKey,
    "HKDF",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: new TextEncoder().encode(info),
    },
    hkdfBase,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptText(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(text)
  );
  return { iv: b64(iv), ct: b64(ct) };
}

async function decryptText(key, iv, ct) {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(iv) },
    key,
    unb64(ct)
  );
  return new TextDecoder().decode(pt);
}

// ---------- group keys ----------
// A group has one AES key per version. Whoever makes a version generates it here
// in the browser and wraps it for each member with the key they share with that
// member, so the server only ever holds wrapped copies.

async function generateGroupKey() {
  // extractable only so it can be wrapped; keys we receive are imported as non-extractable
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

async function wrapGroupKey(wrapKey, groupKey) {
  const raw = await crypto.subtle.exportKey("raw", groupKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wk = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrapKey, raw);
  return { iv: b64(iv), wk: b64(wk) };
}

async function unwrapGroupKey(wrapKey, iv, wk) {
  const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, wrapKey, unb64(wk));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// ---------- forward secrecy: one-time prekeys ----------
// Every message to a friend is also locked with a key that exists exactly once. We keep a
// pile of "prekeys" (public half on the server, private half only here), friends take
// one for each message they send us, and we delete the private half as soon as the
// message has been read. After that nobody can open that message again, not even
// someone who later steals our long-term key and has a copy of what the server stored.

const PREKEY_TARGET = 100; // how many we try to keep on the server
const PREKEY_LOW = 50; // top up when the server has fewer than this

function dbDelete(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// several writes in one go, all or nothing
function dbSetMany(db, entries) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const [key, value] of entries) store.put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// two tabs topping up at the same moment would hand out the same ids twice
function withLock(name, fn) {
  if (typeof navigator !== "undefined" && navigator.locks) return navigator.locks.request(name, fn);
  return fn();
}

const prekeySlot = (username, id) => "prekey:" + username + ":" + id;

// Makes `count` new prekeys. The private halves are saved here first, and only then do we
// return the public halves to upload, so a key someone claims always has its private half.
function makePrekeys(username, count) {
  return withLock("cc-prekeys:" + username, async () => {
    const db = await openDB();
    const counter = "prekey-next:" + username;
    let next = (await dbGet(db, counter)) || 1;
    const entries = [];
    const publics = [];
    for (let i = 0; i < count; i++) {
      const pair = await crypto.subtle.generateKey(ECDH, false, ["deriveBits"]);
      const pub = await exportPub(pair.publicKey);
      entries.push([prekeySlot(username, next), { priv: pair.privateKey, pub }]);
      publics.push({ id: next, pub });
      next++;
    }
    entries.push([counter, next]);
    await dbSetMany(db, entries);
    return publics;
  });
}

async function loadPrekey(username, id) {
  return (await dbGet(await openDB(), prekeySlot(username, id))) || null;
}

async function deletePrekey(username, id) {
  await dbDelete(await openDB(), prekeySlot(username, id));
}
