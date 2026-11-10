// Tests for signing group messages in web/crypto.js. Run with: node --test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "web", "crypto.js"), "utf8");

const lib = new Function(
  "crypto",
  "btoa",
  "atob",
  source + "\nreturn { signGroupMessage, verifyGroupMessage, exportPub, signedBytes };"
)(globalThis.crypto, globalThis.btoa, globalThis.atob);

const { subtle } = globalThis.crypto;
const makeSigning = () => subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);

async function alice() {
  const keys = await makeSigning();
  return { priv: keys.privateKey, pub: await lib.exportPub(keys.publicKey) };
}

test("a signature made by alice verifies against her public key", async () => {
  const a = await alice();
  const sig = await lib.signGroupMessage(a.priv, 7, 2, "alice", "aXY=", "Y3Q=");
  assert.equal(await lib.verifyGroupMessage(a.pub, sig, 7, 2, "alice", "aXY=", "Y3Q="), true);
});

test("the signature is 64 bytes, which is what the server expects", async () => {
  const a = await alice();
  const sig = await lib.signGroupMessage(a.priv, 1, 1, "alice", "aXY=", "Y3Q=");
  assert.equal(Buffer.from(sig, "base64").length, 64);
});

test("somebody else's key does not verify it", async () => {
  const a = await alice();
  const mallory = await alice();
  const sig = await lib.signGroupMessage(mallory.priv, 1, 1, "alice", "aXY=", "Y3Q=");
  assert.equal(await lib.verifyGroupMessage(a.pub, sig, 1, 1, "alice", "aXY=", "Y3Q="), false);
});

test("changing anything that was signed breaks the signature", async () => {
  const a = await alice();
  const sig = await lib.signGroupMessage(a.priv, 5, 3, "alice", "aXY=", "Y3Q=", 9);
  const ok = (...args) => lib.verifyGroupMessage(a.pub, sig, ...args);
  assert.equal(await ok(5, 3, "alice", "aXY=", "Y3Q=", 9), true);
  assert.equal(await ok(6, 3, "alice", "aXY=", "Y3Q=", 9), false, "moved to another group");
  assert.equal(await ok(5, 4, "alice", "aXY=", "Y3Q=", 9), false, "other key version");
  assert.equal(await ok(5, 3, "bob", "aXY=", "Y3Q=", 9), false, "blamed on someone else");
  assert.equal(await ok(5, 3, "alice", "aXZ=", "Y3Q=", 9), false, "other iv");
  assert.equal(await ok(5, 3, "alice", "aXY=", "Y3R=", 9), false, "other ciphertext");
  assert.equal(await ok(5, 3, "alice", "aXY=", "Y3Q=", 10), false, "other extra field");
  assert.equal(await ok(5, 3, "alice", "aXY=", "Y3Q="), false, "missing extra field");
});

test("fields can't be shifted into each other", () => {
  // without the length in front of each field these two would be the same bytes
  const x = lib.signedBytes(1, 1, "ab", "c", "d");
  const y = lib.signedBytes(1, 1, "a", "bc", "d");
  assert.notDeepEqual(x, y);
});

test("garbage in the signature or the key gives false, not an exception", async () => {
  const a = await alice();
  assert.equal(await lib.verifyGroupMessage(a.pub, "!!!", 1, 1, "alice", "aXY=", "Y3Q="), false);
  assert.equal(await lib.verifyGroupMessage("AAAA", "AAAA", 1, 1, "alice", "aXY=", "Y3Q="), false);
});
