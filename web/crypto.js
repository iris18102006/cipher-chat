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

async function deriveSharedKey(privateKey, peerPublicKey) {
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
      info: new TextEncoder().encode("cipher-chat v1"),
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
