// Tests for the download helper (web/sw.js) and the page side of it (web/streamsave.js).
// Both run in Node with a pretend service worker, so no browser is needed: node --test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const swSource = fs.readFileSync(path.join(here, "..", "web", "sw.js"), "utf8");
const pageSource = fs.readFileSync(path.join(here, "..", "web", "streamsave.js"), "utf8");

const ORIGIN = "https://chat.example";

// loads sw.js against a fake `self` and gives back what it registered
function loadWorker() {
  const handlers = {};
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (name, fn) => (handlers[name] = fn),
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  };
  new Function("self", swSource)(self);
  return {
    handlers,
    // a message from the page: prepares a download and returns the page's end of the channel
    prepare(id, name, size) {
      const channel = new MessageChannel();
      handlers.message({ data: { type: "prepare", id, name, size }, ports: [channel.port2] });
      return channel.port1;
    },
    // the browser asking for /_dl/<id>: returns the Response, or null if the worker let it through
    async fetch(urlPath, origin = ORIGIN) {
      let answer = null;
      handlers.fetch({ request: { url: origin + urlPath }, respondWith: (p) => (answer = p) });
      return answer ? await answer : null;
    },
  };
}

function loadPage() {
  return new Function(pageSource + "\nreturn { ssOpenPort, ssSupported };")();
}

const ID = "0123456789abcdef0123456789abcdef";

async function readAll(body) {
  const parts = [];
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return Buffer.concat(parts);
}

test("the page is not supported outside a browser, so it falls back", () => {
  assert.equal(loadPage().ssSupported(), false);
});

test("a file is streamed through in order with the right headers", async () => {
  const worker = loadWorker();
  const { ssOpenPort } = loadPage();
  const port = worker.prepare(ID, 'my "report".pdf', 21);
  let response = null;
  const out = await ssOpenPort(port, () => {
    worker.fetch("/_dl/" + ID).then((r) => (response = r));
  });
  while (!response) await new Promise((r) => setTimeout(r, 1));
  const body = readAll(response.body);
  for (let i = 0; i < 7; i++) await out.write(new Uint8Array([i, i, i]));
  out.close();
  const got = await body;
  assert.deepEqual([...got], [0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6]);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.equal(response.headers.get("content-length"), "21");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy"), /sandbox/);
  // quotes can't break out of the header
  assert.equal(response.headers.get("content-disposition"), "attachment; filename*=UTF-8''my%20_report_.pdf");
});

test("a name with odd characters is made safe", async () => {
  const worker = loadWorker();
  const port = worker.prepare(ID, "../../é\r\nSet-Cookie: x=1.txt", 1);
  const response = await worker.fetch("/_dl/" + ID);
  const header = response.headers.get("content-disposition");
  assert.ok(!/[\r\n"/\\]/.test(header.replace("attachment; filename*=UTF-8''", "")));
  assert.match(header, /^attachment; filename\*=UTF-8''/);
  port.postMessage({ type: "abort" });
  await response.body.getReader().read().catch(() => {});
});

