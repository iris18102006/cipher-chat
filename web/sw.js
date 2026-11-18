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
  if (jobs.has(data.id)) return;
  const job = { name: dlName(data.name), size: Number.isSafeInteger(data.size) && data.size >= 0 ? data.size : -1, port };
  job.timer = setTimeout(() => {
    jobs.delete(data.id);
    port.postMessage({ type: "expired" });
    port.close();
  }, DL_WAIT_MS);
  jobs.set(data.id, job);
  port.postMessage({ type: "ready" });
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(DL_PREFIX)) return;
  event.respondWith(dlAnswer(url.pathname.slice(DL_PREFIX.length)));
});

// a file name that is safe to put in a header: no slashes, no control characters, no quotes
function dlName(name) {
  const clean = String(name || "")
    .replace(/[\u0000-\u001f\u007f"\\/:*?<>|]/g, "_")
    .trim()
    .slice(0, 200);
  return clean || "file";
}

