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
  fcMediaKind, fcHumanSize, fcClock, FC_MEM_SAVE_MAX, fcCanSaveHere };`,
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

// ---------- the message that says where a file is ----------

function sample(extra = {}) {
  return lib.fcDescriptor({ id: "a".repeat(32), secret: lib.fcNewSecret(), size: 5000, name: "holiday.jpg", type: "image/jpeg", kind: "file", ...extra });
}

function broken(change) {
  return lib.FC_PREFIX + JSON.stringify({ ...sample(), ...change });
}

test("a file message goes through the wire and comes back the same", () => {
  const desc = sample();
  assert.deepEqual(lib.fcParse(lib.fcWire(desc)), desc);
  const voice = sample({ kind: "voice", type: "audio/webm", dur: 42 });
  assert.deepEqual(lib.fcParse(lib.fcWire(voice)), voice);
});

test("plain text and junk are not file messages", () => {
  for (const text of ["hello", "", lib.FC_PREFIX, lib.FC_PREFIX + "not json", lib.FC_PREFIX + "[]", lib.FC_PREFIX + "null", lib.FC_PREFIX + '"x"']) {
    assert.equal(lib.fcParse(text), null, text);
  }
  assert.equal(lib.fcParse(null), null);
  assert.equal(lib.fcParse(42), null);
});

test("a file message from somebody else is checked field by field", () => {
  const bad = [
    { id: "A".repeat(32) },
    { id: "short" },
    { id: "../../etc/passwd" },
    { key: "AAAA" },
    { key: 5 },
    { iv: "AAAA" },
    { size: -1 },
    { size: 1.5 },
    { size: lib.FC_MAX_BYTES + 1 },
    { chunks: 99 },
    { name: "" },
    { name: "x".repeat(500) },
    { type: "javascript:alert(1)" },
    { type: "<img src=x>" },
    { kind: "script" },
    { v: 2 },
  ];
  for (const change of bad) assert.equal(lib.fcParse(broken(change)), null, JSON.stringify(change));
});

test("extra fields in a message are dropped", () => {
  const out = lib.fcParse(broken({ evil: "<script>", onclick: "x" }));
  assert.ok(out);
  assert.equal("evil" in out, false);
  assert.equal("onclick" in out, false);
});

test("a voice message has a length within five minutes", () => {
  assert.equal(lib.fcDescriptor({ id: "a".repeat(32), secret: lib.fcNewSecret(), size: 10, name: "v.webm", type: "audio/webm", kind: "voice", dur: 9999 }).dur, 300);
  assert.equal(lib.fcParse(broken({ kind: "voice", type: "audio/webm", dur: 301 })), null);
  assert.equal(lib.fcParse(broken({ kind: "voice", type: "audio/webm", dur: -1 })), null);
  assert.equal(lib.fcParse(broken({ kind: "voice", type: "audio/webm" })), null);
});

test("names are made safe to show and to save", () => {
  assert.ok(!/[\\/]/.test(lib.fcCleanName("../../etc/passwd")));
  assert.ok(!lib.fcCleanName("../../etc/passwd").startsWith("."));
  assert.ok(!lib.fcCleanName("invoice\u202Efdp.exe").includes("\u202e")); // can't flip the end around
  assert.equal(lib.fcCleanName(""), "file");
  assert.equal(lib.fcCleanName("   "), "file");
  assert.equal(lib.fcCleanName(".hidden"), "hidden");
  assert.equal(lib.fcCleanName("a\nb.txt"), "a_b.txt");
  const long = lib.fcCleanName("a".repeat(300) + ".pdf");
  assert.ok(long.length <= 120 && long.endsWith(".pdf"));
});

test("types are cleaned up", () => {
  assert.equal(lib.fcCleanType("IMAGE/PNG; charset=x"), "image/png");
  assert.equal(lib.fcCleanType("audio/webm;codecs=opus"), "audio/webm");
  assert.equal(lib.fcCleanType(""), "application/octet-stream");
  assert.equal(lib.fcCleanType("<script>"), "application/octet-stream");
  assert.equal(lib.fcCleanType("text"), "application/octet-stream");
});

test("only safe types are shown inside the chat", () => {
  const kind = (type, k = "file") => lib.fcMediaKind({ type, kind: k });
  assert.equal(kind("image/png"), "image");
  assert.equal(kind("image/webp"), "image");
  assert.equal(kind("video/mp4"), "video");
  assert.equal(kind("audio/mpeg"), "audio");
  assert.equal(kind("audio/webm", "voice"), "voice");
  // a page or a script must never be shown, only downloaded
  for (const type of ["image/svg+xml", "text/html", "application/xhtml+xml", "application/pdf", "application/octet-stream", "application/javascript"]) {
    assert.equal(kind(type), "file", type);
  }
  assert.equal(kind("video/mp4", "voice"), "video"); // "voice" only counts for audio
});

test("sizes and times read well", () => {
  assert.equal(lib.fcHumanSize(0), "0 B");
  assert.equal(lib.fcHumanSize(1023), "1023 B");
  assert.equal(lib.fcHumanSize(1536), "1.5 KB");
  assert.equal(lib.fcHumanSize(12 * 1024 * 1024), "12 MB");
  assert.equal(lib.fcHumanSize(2048 * 1024 * 1024), "2 GB");
  assert.equal(lib.fcClock(0), "0:00");
  assert.equal(lib.fcClock(75), "1:15");
  assert.equal(lib.fcClock(300), "5:00");
  assert.equal(lib.fcClock(NaN), "0:00");
  assert.equal(lib.fcClock(-3), "0:00");
});

test("small files can be saved in any browser", () => {
  assert.equal(lib.fcCanSaveHere(5 * 1024 * 1024, false), true);
  assert.equal(lib.fcCanSaveHere(lib.FC_MEM_SAVE_MAX, false), true);
});

test("a big file needs a browser that can write to disk", () => {
  const big = lib.FC_MEM_SAVE_MAX + 1;
  assert.equal(lib.fcCanSaveHere(big, false), false);
  assert.equal(lib.fcCanSaveHere(big, undefined), false);
  assert.equal(lib.fcCanSaveHere(big, function showSaveFilePicker() {}), true);
  assert.equal(lib.fcCanSaveHere(2048 * 1024 * 1024, true), true);
});
