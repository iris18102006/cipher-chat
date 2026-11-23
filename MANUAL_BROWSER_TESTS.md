# Manual browser checks

## Streaming downloads

The repository's streaming path is implemented in `web/streamsave.js` and `web/sw.js`; the attachment download code uses it when the browser does not provide the File System Access API.

These checks still need to be run on a machine with real Firefox and Safari:

1. Log in over `https://` or `http://localhost` so the service worker is allowed.
2. Send a file larger than 64 MB.
3. Download it from Firefox and Safari.
4. Confirm the download starts before the full file is held in page memory, the saved size matches, and a cancelled or corrupted transfer does not leave a usable partial file.

Firefox and Safari were not available in this environment, so no result is claimed here.
