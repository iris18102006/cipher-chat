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

function dlHeader(name) {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return "attachment; filename*=UTF-8''" + encoded;
}

function dlAnswer(id) {
  const job = jobs.get(id);
  if (!job) return new Response("not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  // one use only: a second request for the same id finds nothing
  jobs.delete(id);
  clearTimeout(job.timer);
  const port = job.port;
  let waiting = false; // a chunk came in while the browser was still busy with the last one

  const body = new ReadableStream(
    {
      start(controller) {
        port.onmessage = (event) => {
          const msg = event.data || {};
          if (msg.type === "chunk" && msg.data instanceof ArrayBuffer) {
            controller.enqueue(new Uint8Array(msg.data));
            // the page waits for this answer before it sends the next piece
            if (controller.desiredSize > 0) port.postMessage({ type: "next" });
            else waiting = true;
          } else if (msg.type === "end") {
            controller.close();
            port.close();
          } else if (msg.type === "abort") {
            controller.error(new TypeError("download stopped"));
            port.close();
          }
        };
        port.postMessage({ type: "started" });
      },
