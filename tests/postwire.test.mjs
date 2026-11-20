// Tests for the format of a post sent in a chat (web/postwire.js). Run with: node --test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "web", "postwire.js"), "utf8");
const lib = new Function(source + "\nreturn { POST_PREFIX, postWire, postParse };")();

test("a post goes through the wire and back", () => {
  assert.deepEqual(lib.postParse(lib.postWire(42)), { id: 42 });
});

test("normal text is not a post", () => {
  assert.equal(lib.postParse("hello"), null);
  assert.equal(lib.postParse(""), null);
  assert.equal(lib.postParse(undefined), null);
});

test("anything that isn't exactly a post number is refused", () => {
  const bad = [
    '{"v":1,"id":0}',
    '{"v":1,"id":-3}',
    '{"v":1,"id":1.5}',
    '{"v":1,"id":"7"}',
    '{"v":1,"id":1e30}',
    '{"v":2,"id":7}',
    '{"id":7}',
    "null",
    "[]",
    "not json",
  ];
  for (const b of bad) assert.equal(lib.postParse(lib.POST_PREFIX + b), null, b);
});

test("extra fields from an untrusted sender are dropped", () => {
  const got = lib.postParse(lib.POST_PREFIX + '{"v":1,"id":5,"url":"https://evil.example","html":"<b>x</b>"}');
  assert.deepEqual(got, { id: 5 });
});
