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

