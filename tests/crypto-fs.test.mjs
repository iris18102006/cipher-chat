// Tests for the forward secrecy crypto in web/crypto.js. Run with: node --test
// (needs Node 20+, it uses Node's built-in Web Crypto, the same API the browser has)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "web", "crypto.js"), "utf8");

// crypto.js is a plain browser script, so wrap it in a function to get at its helpers
const lib = new Function(
  "crypto",
  "btoa",
  "atob",
  source +
    "\nreturn { sealForwardSecret, openForwardSecret, deriveSharedKey, encryptText, decryptText, exportPub, importPub };"
)(globalThis.crypto, globalThis.btoa, globalThis.atob);

const ECDH = { name: "ECDH", namedCurve: "P-256" };
const { subtle } = globalThis.crypto;

// an identity is made like the app makes it: non-extractable, only for deriveKey
const identity = () => subtle.generateKey(ECDH, false, ["deriveKey"]);

async function prekey() {
  const pair = await subtle.generateKey(ECDH, false, ["deriveBits"]);
  return { priv: pair.privateKey, pub: await lib.exportPub(pair.publicKey) };
}

async function setup() {
  const alice = await identity();
  const bob = await identity();
  const pre = await prekey();
  return { alice, bob, pre };
}

test("a message sealed by alice opens for bob with his prekey", async () => {
  const { alice, bob, pre } = await setup();
  const sealed = await lib.sealForwardSecret(alice.privateKey, bob.publicKey, pre.pub, "hello bob");
  const text = await lib.openForwardSecret(bob.privateKey, alice.publicKey, pre, sealed.eph, sealed.iv, sealed.ct);
  assert.equal(text, "hello bob");
});

test("every message gets its own one-time key", async () => {
  const { alice, bob, pre } = await setup();
  const one = await lib.sealForwardSecret(alice.privateKey, bob.publicKey, pre.pub, "same text");
  const two = await lib.sealForwardSecret(alice.privateKey, bob.publicKey, pre.pub, "same text");
  assert.notEqual(one.eph, two.eph);
  assert.notEqual(one.ct, two.ct);
});

test("without the prekey's private half, a stolen identity key opens nothing", async () => {
  const { alice, bob, pre } = await setup();
  const sealed = await lib.sealForwardSecret(alice.privateKey, bob.publicKey, pre.pub, "secret");
  // the prekey was deleted, all that's left is a different one
  const other = await prekey();
  await assert.rejects(
    lib.openForwardSecret(bob.privateKey, alice.publicKey, { priv: other.priv, pub: pre.pub }, sealed.eph, sealed.iv, sealed.ct)
  );
  // and the old long-term key alone (what every message used before) doesn't open it either
  const oldKey = await lib.deriveSharedKey(bob.privateKey, alice.publicKey);
  await assert.rejects(lib.decryptText(oldKey, sealed.iv, sealed.ct));
});

test("the prekey alone isn't enough either, the identity keys have to match too", async () => {
  const { alice, bob, pre } = await setup();
  const sealed = await lib.sealForwardSecret(alice.privateKey, bob.publicKey, pre.pub, "secret");
  const mallory = await identity();
  await assert.rejects(lib.openForwardSecret(mallory.privateKey, alice.publicKey, pre, sealed.eph, sealed.iv, sealed.ct));
  await assert.rejects(lib.openForwardSecret(bob.privateKey, mallory.publicKey, pre, sealed.eph, sealed.iv, sealed.ct));
});

test("a changed message, key or prekey is refused", async () => {
  const { alice, bob, pre } = await setup();
  const sealed = await lib.sealForwardSecret(alice.privateKey, bob.publicKey, pre.pub, "secret");
  const open = (eph, ct, p = pre) => lib.openForwardSecret(bob.privateKey, alice.publicKey, p, eph, sealed.iv, ct);

  const raw = Uint8Array.from(atob(sealed.ct), (c) => c.charCodeAt(0));
  raw[0] ^= 1;
  await assert.rejects(open(sealed.eph, btoa(String.fromCharCode(...raw))));

  const another = await prekey();
  await assert.rejects(open(another.pub, sealed.ct)); // somebody swapped the sender's key
  await assert.rejects(open(sealed.eph, sealed.ct, { priv: pre.priv, pub: another.pub })); // wrong prekey named
});

test("round trip with keys that went through base64 like they do on the server", async () => {
  const { alice, bob, pre } = await setup();
  const alicePub = await lib.importPub(await lib.exportPub(alice.publicKey));
  const bobPub = await lib.importPub(await lib.exportPub(bob.publicKey));
  const sealed = await lib.sealForwardSecret(alice.privateKey, bobPub, pre.pub, "héllo wörld, emoji-free");
  assert.equal(
    await lib.openForwardSecret(bob.privateKey, alicePub, pre, sealed.eph, sealed.iv, sealed.ct),
    "héllo wörld, emoji-free"
  );
});
