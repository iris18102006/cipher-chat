// The download helper (a service worker). It does one job: when a big file is saved in a browser
// that has no "save to disk" dialog (Firefox, Safari), the page hands the unlocked pieces to this
// worker one at a time and the worker streams them to the browser's download, so the whole file
// never has to sit in memory. That is what lifts the 1 GB limit there.
//
// It never touches the network and never sees a key: the pieces it gets are already unlocked by
// the page. It only answers requests for /_dl/<id>, and only for an id the page just made. Every
// other request goes straight through, as if this worker wasn't here.

const DL_PREFIX = "/_dl/";
const DL_WAIT_MS = 30 * 1000; // how long a prepared download waits for the browser to ask for it
const jobs = new Map();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// The page sends { type: "prepare", id, name, size } and one end of a MessageChannel.
self.addEventListener("message", (event) => {
  const data = event.data;
  const port = event.ports && event.ports[0];
  if (!data || data.type !== "prepare" || !port) return;
  if (typeof data.id !== "string" || !/^[0-9a-f]{32}$/.test(data.id)) return;
