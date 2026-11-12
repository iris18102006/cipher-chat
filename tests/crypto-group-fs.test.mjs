// A whole group conversation between three simulated devices, using the same functions the
// browser uses (web/crypto.js), with IndexedDB swapped for a Map per device. Run: node --test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "web", "crypto.js"), "utf8");

// one device = one copy of crypto.js with its own storage
function device(name) {
  const store = new Map();
  return { name, store, ...build(store) };
}

// the copy of crypto.js for one device, with IndexedDB replaced by `store`
function build(store) {
  const fn = new Function(
    "store",
    "crypto",
    "btoa",
    "atob",
    source +
      `
      openDB = async () => ({});
      dbGet = async (db, k) => store.get(k);
      dbSet = async (db, k, v) => void store.set(k, v);
      dbDelete = async (db, k) => void store.delete(k);
      dbSetMany = async (db, entries) => { for (const [k, v] of entries) store.set(k, v); };
      return { generateGroupKey, groupSeedFromKey, adoptGroupVersion, withChain, chainSeal, chainOpen,
               loadChain, saveGroupPlain, loadGroupPlain, saveGroupPending, loadGroupPending, dropGroupPending };
    `
  );
  return fn(store, globalThis.crypto, globalThis.btoa, globalThis.atob);
}

const GID = 7;
const NAMES = ["alice", "bob", "carol"];

async function group() {
  const devs = Object.fromEntries(NAMES.map((n) => [n, device(n)]));
  // alice makes the key; in the app it travels wrapped, here the three just get the same bytes
  const seed = await devs.alice.groupSeedFromKey(await devs.alice.generateGroupKey());
  for (const n of NAMES) await devs[n].adoptGroupVersion(n, GID, 1, seed, NAMES);
  return devs;
}

// what groups.js does to send and to open
async function send(dev, from, text) {
  const out = await dev.withChain(from, GID, 1, from, async (chain) => {
    const s = await dev.chainSeal(chain, text);
    return { state: s.state, sealed: s };
  });
  return out.sealed;
}

async function open(dev, me, from, m) {
  const out = await dev.withChain(me, GID, 1, from, async (chain) => {
    const o = await dev.chainOpen(chain, m.n, m.iv, m.ct);
    return { state: o.state, text: o.text };
  });
  return out.text;
}

test("everyone can read what everyone sends, in any order", async () => {
  const d = await group();
  const a1 = await send(d.alice, "alice", "hi from alice");
  const b1 = await send(d.bob, "bob", "hi from bob");
  const a2 = await send(d.alice, "alice", "alice again");
  for (const reader of ["bob", "carol"]) {
    assert.equal(await open(d[reader], reader, "alice", a1), "hi from alice");
    assert.equal(await open(d[reader], reader, "alice", a2), "alice again");
  }
  assert.equal(await open(d.alice, "alice", "bob", b1), "hi from bob");
  assert.equal(await open(d.carol, "carol", "bob", b1), "hi from bob");
  const a3 = await send(d.alice, "alice", "third");
  const a4 = await send(d.alice, "alice", "fourth");
  assert.equal(await open(d.carol, "carol", "alice", a4), "fourth"); // the 4th arrives before the 3rd
  assert.equal(await open(d.carol, "carol", "alice", a3), "third");
});

test("a stolen device can't open what it already read, or anything sent before the theft", async () => {
  const d = await group();
  const early = [];
  for (let i = 0; i < 3; i++) early.push(await send(d.alice, "alice", "secret " + i));
  for (const m of early) await open(d.bob, "bob", "alice", m);
  // a thief takes bob's storage, and has the ciphertext from the server too
  const stolen = device("thief");
  for (const [k, v] of d.bob.store) stolen.store.set(k, v);
  for (const m of early) await assert.rejects(() => open(stolen, "bob", "alice", m), /gone/);
});

test("...but what was sent after the theft is open to them, that's the limit of this", async () => {
  const d = await group();
  const stolen = device("thief");
  for (const [k, v] of d.bob.store) stolen.store.set(k, v);
  const later = await send(d.alice, "alice", "after the theft");
  assert.equal(await open(stolen, "bob", "alice", later), "after the theft");
});

test("nothing on a device can rebuild the group key", async () => {
  const d = await group();
  for (const v of d.bob.store.values()) {
    // chains are non-extractable keys, not bytes. Stored text is text. Nothing is a raw key.
    assert.ok(!(v instanceof Uint8Array) && !(v instanceof ArrayBuffer));
  }
  const chain = await d.bob.loadChain("bob", GID, 1, "alice");
  await assert.rejects(() => globalThis.crypto.subtle.exportKey("raw", chain.ck));
});

test("setting up again later doesn't rewind a chain that has moved on", async () => {
  const d = await group();
  const m = await send(d.alice, "alice", "one");
  await open(d.bob, "bob", "alice", m);
  const seed = globalThis.crypto.getRandomValues(new Uint8Array(32));
  assert.equal(await d.bob.adoptGroupVersion("bob", GID, 1, seed, NAMES), 0); // nothing new to add
  assert.equal((await d.bob.loadChain("bob", GID, 1, "alice")).n, 1);
});

test("two tabs reading at once don't open the same key twice", async () => {
  const d = await group();
  const msgs = [];
  for (let i = 0; i < 5; i++) msgs.push(await send(d.alice, "alice", "m" + i));
  // the same device (same store) opens them all at the same moment
  const results = await Promise.all(msgs.map((m) => open(d.bob, "bob", "alice", m)));
  assert.deepEqual(results, ["m0", "m1", "m2", "m3", "m4"]);
});

test("a message I sent is kept as text under its client id, then under its real id", async () => {
  const d = await group();
  await d.alice.saveGroupPending("alice", GID, "cid-1", "what I wrote");
  assert.equal(await d.alice.loadGroupPending("alice", GID, "cid-1"), "what I wrote");
  await d.alice.saveGroupPlain("alice", GID, 42, "what I wrote");
  await d.alice.dropGroupPending("alice", GID, "cid-1");
  assert.equal(await d.alice.loadGroupPending("alice", GID, "cid-1"), null);
  assert.equal(await d.alice.loadGroupPlain("alice", GID, 42), "what I wrote");
  assert.equal(await d.alice.loadGroupPlain("alice", GID, 43), null);
});

test("a device that joins a version later starts its chains at zero and still reads what comes", async () => {
  const d = await group();
  const seed = await d.alice.groupSeedFromKey(await d.alice.generateGroupKey());
  const dave = device("dave");
  for (const n of [...NAMES, "dave"]) await d[n]?.adoptGroupVersion(n, GID, 2, seed, [...NAMES, "dave"]);
  await dave.adoptGroupVersion("dave", GID, 2, seed, [...NAMES, "dave"]);
  const m = await d.alice.withChain("alice", GID, 2, "alice", async (c) => {
    const s = await d.alice.chainSeal(c, "welcome dave");
    return { state: s.state, sealed: s };
  });
  const text = await dave.withChain("dave", GID, 2, "alice", async (c) => {
    const o = await dave.chainOpen(c, m.sealed.n, m.sealed.iv, m.sealed.ct);
    return { state: o.state, text: o.text };
  });
  assert.equal(text.text, "welcome dave");
});
