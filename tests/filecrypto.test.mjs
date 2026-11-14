// Tests for locking files in web/filecrypto.js. Run with: node --test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "web", "filecrypto.js"), "utf8");

// the file only defines things when it loads, so it can run without a page
const lib = new Function(
  "crypto",
  "btoa",
  "atob",
  source +
    `
return { FC_CHUNK, FC_TAG, FC_MAX_BYTES, FC_PREFIX, FC_VOICE_MAX_SECONDS, fcB64, fcUnb64, fcCount, fcCipherSize,
  fcNewSecret, fcImport, fcIv, fcSeal, fcOpen, fcCleanName, fcCleanType, fcDescriptor, fcWire, fcParse,
  fcMediaKind, fcHumanSize, fcClock };`,
)(globalThis.crypto, globalThis.btoa, globalThis.atob);

async function setup() {
  const secret = lib.fcNewSecret();
  return { secret, key: await lib.fcImport(secret.key) };
}

test("a piece opens with the same key, number and place", async () => {
  const { secret, key } = await setup();
  const plain = new Uint8Array([1, 2, 3, 4, 5]);
  const sealed = await lib.fcSeal(key, secret.prefix, 0, true, plain);
  assert.equal(sealed.length, plain.length + lib.FC_TAG);
  assert.deepEqual(await lib.fcOpen(key, secret.prefix, 0, true, sealed), plain);
});

test("an empty file is one empty piece", async () => {
  const { secret, key } = await setup();
  const sealed = await lib.fcSeal(key, secret.prefix, 0, true, new Uint8Array(0));
  assert.equal(sealed.length, lib.FC_TAG);
  assert.equal((await lib.fcOpen(key, secret.prefix, 0, true, sealed)).length, 0);
});

test("pieces can't be put in another order", async () => {
  const { secret, key } = await setup();
  const sealed = await lib.fcSeal(key, secret.prefix, 0, false, new Uint8Array([9, 9]));
  await assert.rejects(lib.fcOpen(key, secret.prefix, 1, false, sealed));
});

test("cutting the end off a file is noticed", async () => {
  const { secret, key } = await setup();
  const middle = await lib.fcSeal(key, secret.prefix, 1, false, new Uint8Array([1]));
  const last = await lib.fcSeal(key, secret.prefix, 1, true, new Uint8Array([1]));
  // a middle piece can't be passed off as the last one, or the other way round
  await assert.rejects(lib.fcOpen(key, secret.prefix, 1, true, middle));
  await assert.rejects(lib.fcOpen(key, secret.prefix, 1, false, last));
});

test("a piece from another file is refused", async () => {
  const one = await setup();
  const two = await setup();
  const sealed = await lib.fcSeal(one.key, one.secret.prefix, 0, true, new Uint8Array([1, 2]));
  await assert.rejects(lib.fcOpen(two.key, one.secret.prefix, 0, true, sealed));
  await assert.rejects(lib.fcOpen(one.key, two.secret.prefix, 0, true, sealed));
});

test("a changed byte is refused", async () => {
  const { secret, key } = await setup();
  const sealed = await lib.fcSeal(key, secret.prefix, 0, true, new Uint8Array(100));
  for (const at of [0, 50, sealed.length - 1]) {
    const bad = sealed.slice();
    bad[at] ^= 1;
    await assert.rejects(lib.fcOpen(key, secret.prefix, 0, true, bad), `byte ${at}`);
  }
});

test("no two pieces share a nonce", () => {
  const prefix = new Uint8Array(8).fill(7);
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(lib.fcB64(lib.fcIv(prefix, i)));
  assert.equal(seen.size, 2000);
  assert.deepEqual([...lib.fcIv(prefix, 258).slice(8)], [0, 0, 1, 2]); // the piece number, big endian
});

test("sizes add up", () => {
  assert.equal(lib.fcCount(0), 1);
  assert.equal(lib.fcCount(lib.FC_CHUNK), 1);
  assert.equal(lib.fcCount(lib.FC_CHUNK + 1), 2);
  assert.equal(lib.fcCipherSize(0), 16);
  assert.equal(lib.fcCipherSize(lib.FC_CHUNK + 1), lib.FC_CHUNK + 1 + 2 * 16);
  assert.equal(lib.fcCount(lib.FC_MAX_BYTES), 512);
});

test("base64 copes with big arrays", () => {
  const big = new Uint8Array(300000).map((_, i) => i % 251);
  assert.deepEqual(lib.fcUnb64(lib.fcB64(big)), big);
});
