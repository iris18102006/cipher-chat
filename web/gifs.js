// The GIF button in chats: pick a GIF from your own library or (when the server has a GIPHY key)
// from a search, and it is sent like any picture: locked in your browser, then sent.
// Loaded after attachments.js. Uses $, el, api, toast, whyFailed from app.js, sendFiles from
// attachments.js, sendFile from profile-media.js and plainButton from dialogs.js.
//
// The browser never talks to GIPHY. Search words go to our server, which asks GIPHY and passes
// the pictures on, so the page's strict content policy stays as it is.

const gifs = { open: false, tab: "search", search: false, loaded: false, mine: [], max: 40, timer: null, next: null, query: "", busy: false, postPick: null };

function gifPanel() {
  return $("gif-panel");
}

function closeGifs() {
  gifs.open = false;
  gifPanel().hidden = true;
  $("gif-btn").setAttribute("aria-expanded", "false");
  gifs.postPick = null;
}

// Feed composers use the same server-mediated GIF picker as chats, but attach the
// downloaded bytes to /api/post-media instead of sending a chat attachment.
function openGifsForPost(onPick) {
  gifs.postPick = onPick;
  openGifs();
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
  paintGifs();
  if (gifs.tab === "search" && gifs.search) runSearch(false);
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
    const postPick = gifs.postPick;
    closeGifs();
    if (postPick) await postPick(file);
    else await sendFiles([file], "file");
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

function paintGifs() {
  const panel = gifPanel();
  const tabs = el("div", "gif-tabs");
  const s = plainButton("Search GIFs", () => {
    gifs.tab = "search";
    paintGifs();
    if (gifs.search) runSearch(false);
  }, gifs.tab === "search" ? "on" : "");
  tabs.append(s);
  tabs.append(plainButton("Saved (" + gifs.mine.length + ")", () => {
    gifs.tab = "mine";
    paintGifs();
  }, gifs.tab === "mine" ? "on" : ""));
  tabs.append(plainButton("\u00d7", closeGifs, "gif-close"));
  tabs.lastChild.setAttribute("aria-label", "close the GIF picker");
  const body = el("div", "gif-body");
  if (gifs.tab === "search" && !gifs.search) {
    // nothing to search with yet: say what to do, in words anybody running the server can follow
    body.append(
      el("p", "list-empty", "GIF search isn't switched on yet."),
      el("p", "gif-note", "Whoever runs this server needs a free key from developers.giphy.com. Put it on the first line of a file called giphy.key next to server.py (or set CIPHER_GIPHY_KEY), then restart the server.")
    );
  } else if (gifs.tab === "search") {
    const input = el("input", "gif-search");
    input.type = "search";
    input.placeholder = "search GIFs...";
    input.value = gifs.query;
    input.setAttribute("aria-label", "search GIFs");
    input.oninput = () => {
      gifs.query = input.value;
      clearTimeout(gifs.timer);
      gifs.timer = setTimeout(() => runSearch(false), 350);
    };
    const grid = el("div", "gif-grid");
    grid.id = "gif-grid";
    const more = plainButton("More", () => runSearch(true), "gif-more");
    more.id = "gif-more";
    more.hidden = true;
    body.append(input, grid, more, el("p", "gif-credit", "Powered by GIPHY"));
  } else {
    const bar = el("div", "gif-bar");
    const file = el("input");
    file.type = "file";
    file.accept = "image/gif,image/webp,image/png,image/jpeg";
    file.multiple = true;
    file.hidden = true;
    const add = plainButton("+ Add a GIF", () => file.click());
    add.disabled = gifs.mine.length >= gifs.max;
    const note = el("span", "gif-note", gifs.mine.length + " of " + gifs.max + " saved. Search is the easy way to find GIFs, this is for ones you upload yourself.");
    file.onchange = async () => {
      const picked = [...file.files];
      file.value = "";
      add.disabled = true;
      for (const f of picked) {
        const why = checkPicture(f, 4);
        if (why) {
          toast(why);
          continue;
        }
        try {
          const data = await sendFile("/api/me/gifs", "POST", f);
          gifs.mine = data.gifs;
        } catch (ex) {
          toast(ex.message);
          break;
        }
      }
      paintGifs();
    };
    bar.append(add, file, note);
    const grid = el("div", "gif-grid");
    if (!gifs.mine.length) grid.append(el("p", "list-empty", "No GIFs yet. Add some, then send them to anyone in a chat."));
    for (const g of gifs.mine) {
      grid.append(
        gifTile(g.url, "", () => sendGif(g.url), async () => {
          try {
            gifs.mine = (await sendJson("/api/me/gifs/" + g.id, "DELETE")).gifs;
            paintGifs();
          } catch (ex) {
            toast(ex.message);
          }
        })
      );
    }
    body.append(bar, grid);
  }
  panel.replaceChildren(tabs, body);
}

// searching, or what's popular when the box is empty. `more` adds the next page.
async function runSearch(more) {
  const grid = $("gif-grid");
  if (!grid) return;
  const q = gifs.query.trim();
  const stamp = (gifs.stamp = (gifs.stamp || 0) + 1);
  const offset = more ? gifs.next || 0 : 0;
  if (!more) grid.replaceChildren(el("p", "list-empty", "searching..."));
  try {
    const data = await api("/api/gifs/search?" + new URLSearchParams({ q, offset: String(offset) }));
    if (stamp !== gifs.stamp || !$("gif-grid")) return; // a newer search took over
    if (!more) grid.replaceChildren();
    if (!more && !data.gifs.length) grid.append(el("p", "list-empty", "nothing found"));
    for (const g of data.gifs) {
      grid.append(gifTile(g.preview, g.title, () => sendGif("/api/gifs/media/" + g.id + "/full")));
    }
    gifs.next = data.next;
    $("gif-more").hidden = data.next == null;
  } catch (ex) {
    if (stamp === gifs.stamp && $("gif-grid")) $("gif-grid").replaceChildren(el("p", "list-empty", whyFailed(ex, "couldn't search, try again")));
  }
}

$("gif-btn").onclick = () => (gifs.open ? closeGifs() : openGifs());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && gifs.open) closeGifs();
});
// clicking anywhere else closes the picker
document.addEventListener("mousedown", (e) => {
  if (gifs.open && !gifPanel().contains(e.target) && e.target !== $("gif-btn")) closeGifs();
});
