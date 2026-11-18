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

