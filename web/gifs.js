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

// sends one GIF: fetches the bytes from our own server and sends them as a picture
async function sendGif(url) {
  if (gifs.busy) return;
  gifs.busy = true;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("couldn't load that GIF");
    const blob = await res.blob();
    const type = blob.type === "image/webp" ? "image/webp" : "image/gif";
    const file = new File([blob], "gif-" + Date.now() + (type === "image/webp" ? ".webp" : ".gif"), { type });
    closeGifs();
    await sendFiles([file], "file");
  } catch (ex) {
    toast(whyFailed(ex, "Couldn't send that GIF, try again."));
  } finally {
    gifs.busy = false;
  }
}

function gifTile(src, label, onPick, onRemove) {
  const wrap = el("div", "gif-tile");
  const b = plainButton("", () => onPick(), "gif-pick");
  b.setAttribute("aria-label", "send " + (label || "this GIF"));
  const img = el("img");
  img.src = src;
  img.alt = label || "";
  img.loading = "lazy";
  img.draggable = false;
  b.append(img);
  wrap.append(b);
  if (onRemove) {
    const x = plainButton("\u00d7", onRemove, "gif-remove");
    x.setAttribute("aria-label", "remove this GIF from my library");
    wrap.append(x);
  }
  return wrap;
}

