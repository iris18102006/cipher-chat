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

