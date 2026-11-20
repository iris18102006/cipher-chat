// The GIF button in chats: pick a GIF from your own library or (when the server has a GIPHY key)
// from a search, and it is sent like any picture: locked in your browser, then sent.
// Loaded after attachments.js. Uses $, el, api, toast, whyFailed from app.js, sendFiles from
// attachments.js, sendFile from profile-media.js and plainButton from dialogs.js.
//
// The browser never talks to GIPHY. Search words go to our server, which asks GIPHY and passes
// the pictures on, so the page's strict content policy stays as it is.

const gifs = { open: false, tab: "mine", search: false, loaded: false, mine: [], max: 40, timer: null, next: null, query: "", busy: false };

function gifPanel() {
  return $("gif-panel");
}

function closeGifs() {
  gifs.open = false;
  gifPanel().hidden = true;
  $("gif-btn").setAttribute("aria-expanded", "false");
}

async function openGifs() {
  gifs.open = true;
  gifPanel().hidden = false;
  $("gif-btn").setAttribute("aria-expanded", "true");
  if (!gifs.loaded) {
    try {
      const [status, mine] = await Promise.all([api("/api/gifs/status"), api("/api/me/gifs")]);
      gifs.search = status.search;
      gifs.mine = mine.gifs;
      gifs.max = mine.max;
      gifs.loaded = true;
    } catch (ex) {
      toast(whyFailed(ex, "Couldn't open the GIFs, try again."));
      return closeGifs();
    }
  }
  gifs.tab = gifs.search ? gifs.tab : "mine";
  paintGifs();
  if (gifs.tab === "search") runSearch(false);
}

