// Tests for the group message ratchet in web/crypto.js. Run with: node --test
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
  source + "\nreturn { groupChainStart, chainStep, newChain, chainSeal, chainOpen, MAX_SKIP };"
)(globalThis.crypto, globalThis.btoa, globalThis.atob);

const root = () => globalThis.crypto.getRandomValues(new Uint8Array(32));
const chainFor = async (rootRaw, sender = "alice", gid = 1, v = 1) =>
  lib.newChain(await lib.groupChainStart(rootRaw, gid, v, sender));

test("everybody who knows the group key gets the same chain for a sender", async () => {
  const r = root();
  let sender = await chainFor(r);
  let reader = await chainFor(r);
  const sealed = await lib.chainSeal(sender, "hello group");
  const opened = await lib.chainOpen(reader, sealed.n, sealed.iv, sealed.ct);
  assert.equal(opened.text, "hello group");
});

test("a run of messages in order, numbers go up one at a time", async () => {
  const r = root();
  let s = await chainFor(r);
  let rd = await chainFor(r);
  for (let i = 0; i < 5; i++) {
    const m = await lib.chainSeal(s, "msg " + i);
    s = m.state;
    assert.equal(m.n, i);
    const o = await lib.chainOpen(rd, m.n, m.iv, m.ct);
    rd = o.state;
    assert.equal(o.text, "msg " + i);
  }
  assert.equal(rd.n, 5);
  assert.deepEqual(Object.keys(rd.skipped), []);
});

test("every message gets its own key", async () => {
  const r = root();
  let s = await chainFor(r);
  const a = await lib.chainSeal(s, "same text");
  const b = await lib.chainSeal(a.state, "same text");
  assert.notEqual(a.ct, b.ct);
});

test("a message can only be opened once, its key is deleted when it's used", async () => {
  const r = root();
  const s = await chainFor(r);
  const rd = await chainFor(r);
  const m = await lib.chainSeal(s, "once");
  const first = await lib.chainOpen(rd, m.n, m.iv, m.ct);
  assert.equal(first.text, "once");
  // the state after reading has moved on: that message can't be opened with it any more
  await assert.rejects(() => lib.chainOpen(first.state, m.n, m.iv, m.ct), /gone/);
});

test("late and out-of-order messages still open, once each", async () => {
  const r = root();
  let s = await chainFor(r);
  const sealed = [];
  for (let i = 0; i < 4; i++) {
    const m = await lib.chainSeal(s, "m" + i);
    s = m.state;
    sealed.push(m);
  }
  let rd = await chainFor(r);
  const get = async (i) => {
    const o = await lib.chainOpen(rd, sealed[i].n, sealed[i].iv, sealed[i].ct);
    rd = o.state;
    return o.text;
  };
  assert.equal(await get(2), "m2"); // 0 and 1 are skipped over
  assert.deepEqual(Object.keys(rd.skipped).sort(), ["0", "1"]);
  assert.equal(await get(0), "m0");
  assert.equal(await get(3), "m3");
  assert.equal(await get(1), "m1");
  assert.deepEqual(Object.keys(rd.skipped), []);
  await assert.rejects(() => lib.chainOpen(rd, 1, sealed[1].iv, sealed[1].ct), /gone/);
});

test("somebody with the wrong group key opens nothing", async () => {
  const s = await chainFor(root());
  const stranger = await chainFor(root());
  const m = await lib.chainSeal(s, "secret");
  await assert.rejects(() => lib.chainOpen(stranger, m.n, m.iv, m.ct));
});

test("each sender has their own chain", async () => {
  const r = root();
  const alice = await chainFor(r, "alice");
  const bobAsSeenByAlice = await chainFor(r, "bob");
  const m = await lib.chainSeal(alice, "from alice");
  await assert.rejects(() => lib.chainOpen(bobAsSeenByAlice, m.n, m.iv, m.ct));
});

test("another group or key version gives a different chain", async () => {
  const r = root();
  const m = await lib.chainSeal(await chainFor(r, "alice", 1, 1), "x");
  for (const [gid, v] of [[2, 1], [1, 2]]) {
    const other = await chainFor(r, "alice", gid, v);
    await assert.rejects(() => lib.chainOpen(other, m.n, m.iv, m.ct));
  }
});

test("a fake message doesn't move the chain on: the caller keeps the old state", async () => {
  const r = root();
  const s = await chainFor(r);
  const rd = await chainFor(r);
  const m = await lib.chainSeal(s, "real");
  await assert.rejects(() => lib.chainOpen(rd, m.n, m.iv, "AAAA" + m.ct.slice(4)));
  // rd was not changed, so the real message still opens
  assert.equal((await lib.chainOpen(rd, m.n, m.iv, m.ct)).text, "real");
  assert.equal(rd.n, 0);
});

test("the state returned is new, the one passed in is left alone", async () => {
  const r = root();
  const rd = await chainFor(r);
  const m = await lib.chainSeal(await chainFor(r), "x");
  const o = await lib.chainOpen(rd, m.n, m.iv, m.ct);
  assert.notEqual(o.state, rd);
  assert.equal(rd.n, 0);
  assert.equal(o.state.n, 1);
});

test("jumping too far ahead is refused instead of grinding through thousands of steps", async () => {
  const rd = await chainFor(root());
  await assert.rejects(() => lib.chainOpen(rd, lib.MAX_SKIP + 1, "AAAAAAAAAAAAAAAA", "AAAA"), /too many/);
  await assert.rejects(() => lib.chainOpen(rd, -1, "AAAA", "AAAA"), /bad message number/);
  await assert.rejects(() => lib.chainOpen(rd, 1.5, "AAAA", "AAAA"), /bad message number/);
});

test("chain keys can't be exported", async () => {
  const ck = await lib.groupChainStart(root(), 1, 1, "alice");
  await assert.rejects(() => globalThis.crypto.subtle.exportKey("raw", ck));
  const { mk, next } = await lib.chainStep(ck);
  await assert.rejects(() => globalThis.crypto.subtle.exportKey("raw", mk));
  await assert.rejects(() => globalThis.crypto.subtle.exportKey("raw", next));
});
