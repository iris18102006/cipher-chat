// Saving a big file in browsers that have no "save to disk" dialog (Firefox, Safari): the unlocked
// pieces are streamed through the download helper in web/sw.js, so the file never has to fit in
// memory. Chrome and Edge don't need this, they write straight to disk. If anything here is
// missing or fails before the first piece, attachments.js falls back to the old way.

const SS_READY_MS = 5000; // how long to wait for the helper to wake up before giving up

function ssSupported() {
  return Boolean(
    typeof navigator !== "undefined" &&
      navigator.serviceWorker &&
      typeof window !== "undefined" &&
      window.isSecureContext &&
      typeof ReadableStream !== "undefined" &&
      typeof MessageChannel !== "undefined",
  );
}

// started once when the page loads, so the helper is ready by the time somebody clicks Download
function ssRegister() {
  if (!ssSupported()) return;
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
}

function ssRandomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function ssWithTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("nostream")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// Talks to the helper over `port` and hands back { write, close, abort }. `startDownload` is what
// makes the browser ask the helper for the file (a click on a link). It is a parameter so the
// message handling can be tested without a browser.
async function ssOpenPort(port, startDownload) {
