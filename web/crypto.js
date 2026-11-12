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

// ---------- forward secrecy: the key for one message ----------
// Two secrets go into every message key:
//   - the long-term shared key (your identity + their identity), which proves who's talking
//   - a one-time secret from the sender's fresh key and the receiver's prekey
// It's used as the HKDF salt, the long-term secret is the key material. Whoever knows only
// one of the two gets nothing, so once the prekey is deleted, the one-time half is gone
// for good and a stolen identity key opens nothing that was sent this way.

const FS_INFO = "cipher-chat fs v1";

function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// The same on both sides. The sender calls it with (fresh private key, prekey public key),
// the receiver with (prekey private key, sender's fresh public key).
async function fsMessageKey(identityPriv, peerIdentityPub, onePrivate, onePeerPublic, ephPubB64, prekeyPubB64) {
  const oneTimeSecret = await crypto.subtle.deriveBits({ name: "ECDH", public: onePeerPublic }, onePrivate, 256);
  const longTerm = await crypto.subtle.deriveKey(
    { name: "ECDH", public: peerIdentityPub },
    identityPriv,
    "HKDF",
    false,
    ["deriveKey"]
  );
  // both public keys are in the info too, so the key is tied to this exact exchange
  const info = concatBytes(new TextEncoder().encode(FS_INFO), unb64(ephPubB64), unb64(prekeyPubB64));
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: oneTimeSecret, info },
    longTerm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// Lock one message. The fresh key made here is thrown away right after, only its public half
// travels with the message.
async function sealForwardSecret(identityPriv, peerIdentityPub, prekeyPubB64, text) {
  const eph = await crypto.subtle.generateKey(ECDH, false, ["deriveBits"]);
  const ephPubB64 = await exportPub(eph.publicKey);
  const prekeyPub = await importPub(prekeyPubB64);
  const key = await fsMessageKey(identityPriv, peerIdentityPub, eph.privateKey, prekeyPub, ephPubB64, prekeyPubB64);
  const { iv, ct } = await encryptText(key, text);
  return { iv, ct, eph: ephPubB64 };
}

// Open one message with the prekey it was locked to ({ priv, pub } from loadPrekey).
async function openForwardSecret(identityPriv, peerIdentityPub, prekey, ephPubB64, iv, ct) {
  const ephPub = await importPub(ephPubB64);
  const key = await fsMessageKey(identityPriv, peerIdentityPub, prekey.priv, ephPub, ephPubB64, prekey.pub);
  return decryptText(key, iv, ct);
}

// ---------- forward secrecy: keeping messages readable on this device ----------
// A forward secret message can only be opened once, so the text has to be kept here after
// that. This is the same trust as the private key: it lives in this browser's IndexedDB
// and never leaves it. Messages we send are saved too (nobody, including us, can open our
// own sent message from the ciphertext later). A sent message is saved under its cid first,
// because only the server knows its id, and moved to the id once the server echoes it back.

const plainSlot = (username, id) => "plain:" + username + ":" + id;
const pendingSlot = (username, cid) => "pending:" + username + ":" + cid;

async function savePlain(username, id, text) {
  await dbSet(await openDB(), plainSlot(username, id), text);
}

async function loadPlain(username, id) {
  const text = await dbGet(await openDB(), plainSlot(username, id));
  return typeof text === "string" ? text : null;
}

async function savePending(username, cid, text) {
  await dbSet(await openDB(), pendingSlot(username, cid), text);
}

async function loadPending(username, cid) {
  const text = await dbGet(await openDB(), pendingSlot(username, cid));
  return typeof text === "string" ? text : null;
}

async function dropPending(username, cid) {
  await dbDelete(await openDB(), pendingSlot(username, cid));
}

// ---------- signing group messages ----------
// A group shares one key, so on its own any member could make a message that looks like it
// came from someone else. Every group message is also signed with the sender's own signing
// key (ECDSA P-256). The private half is made here, never leaves this browser, and the public
// half goes to the server like the identity key does. Members check the signature themselves,
// the server is not trusted to do it.

const SIGN_ALG = { name: "ECDSA", namedCurve: "P-256" };
const SIGN_HASH = { name: "ECDSA", hash: "SHA-256" };
const SIGN_PREFIX = "cipher-chat group-message v1";

// One signing key per username, kept next to the identity key.
async function loadOrCreateSigning(username) {
  const db = await openDB();
  const slot = "signing:" + username;
  let keys = await dbGet(db, slot);
  if (!keys) {
    keys = await crypto.subtle.generateKey(SIGN_ALG, false, ["sign", "verify"]);
    await dbSet(db, slot, keys);
  }
  return keys;
}

function importSignPub(s) {
  return crypto.subtle.importKey("raw", unb64(s), SIGN_ALG, true, ["verify"]);
}

// The exact bytes that get signed. Every field has its length in front of it, so one field
// can't spill into the next ("ab"+"c" is not "a"+"bc"). The group, the key version and the
// sender are in there, which means a signed message can't be moved to another group, passed
// off as being from another key version, or blamed on someone else.
function signedBytes(gid, version, sender, iv, ct, extra) {
  const enc = new TextEncoder();
  const parts = [SIGN_PREFIX, String(gid), String(version), sender, iv, ct, extra == null ? "" : String(extra)];
  const bytes = parts.map((p) => enc.encode(p));
  const out = new Uint8Array(bytes.reduce((n, b) => n + 4 + b.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const b of bytes) {
    view.setUint32(at, b.length);
    out.set(b, at + 4);
    at += 4 + b.length;
  }
  return out;
}

async function signGroupMessage(signPriv, gid, version, sender, iv, ct, extra) {
  const sig = await crypto.subtle.sign(SIGN_HASH, signPriv, signedBytes(gid, version, sender, iv, ct, extra));
  return b64(sig);
}

// true only if `sigB64` really is `sender`'s signature over exactly this message
async function verifyGroupMessage(signPubB64, sigB64, gid, version, sender, iv, ct, extra) {
  try {
    const pub = await importSignPub(signPubB64);
    return await crypto.subtle.verify(SIGN_HASH, pub, unb64(sigB64), signedBytes(gid, version, sender, iv, ct, extra));
  } catch {
    return false;
  }
}

// ---------- forward secrecy for groups: a ratchet per sender ----------
// Every member of a group has their own chain of keys for each group key version. The first
// link comes from the group key (so everyone can work out everybody's chain), and from there
// each message uses one key and then the chain steps forward and the old link is thrown away.
// Steps only go one way, so a key that's been used and deleted can't be worked back out of
// the keys that are left. Once a device has set its chains up it deletes the group key
// itself, and tells the server to delete its wrapped copy (see groups.js).

const CHAIN_INFO = "cipher-chat group-chain v1";
const MAX_SKIP = 1000; // how many missed messages in a row we'll keep keys for

const utf8 = (s) => new TextEncoder().encode(s);

// The first link of one sender's chain. `rootRaw` is the group key's 32 bytes.
async function groupChainStart(rootRaw, gid, version, sender) {
  const base = await crypto.subtle.importKey("raw", rootRaw, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: utf8(CHAIN_INFO), info: utf8(gid + "|" + version + "|" + sender) },
    base,
    256
  );
  return crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveBits"]);
}

// One step: the key for this message, and the chain key for the next one. Neither can be
// exported and neither can be turned back into `ck`.
async function chainStep(ck) {
  const derive = (info) =>
    crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(info) }, ck, 256);
  const [mkBits, nextBits] = await Promise.all([derive("message key"), derive("next chain key")]);
  return {
    mk: await crypto.subtle.importKey("raw", mkBits, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
    next: await crypto.subtle.importKey("raw", nextBits, "HKDF", false, ["deriveBits"]),
  };
}
