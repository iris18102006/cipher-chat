// The picture viewer: click a picture in a chat and it opens big, right here in the app (no new
// window or tab). Left and right arrows (or the buttons) go through the other pictures in the
// chat, Escape or a click outside closes it.
// Loaded after dialogs.js. Uses el from app.js and icon, iconButton from icons.js.

const lightbox = { root: null, items: [], at: 0, returnFocus: null };

// items: [{ url, name }] (only blob: and same-site urls go in), at: which one to show first
function openLightbox(items, at) {
  if (!items.length) return;
  closeLightbox();
  lightbox.items = items;
  lightbox.at = Math.min(Math.max(at || 0, 0), items.length - 1);
  lightbox.returnFocus = document.activeElement;

  const root = el("div", "lb-overlay");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "picture viewer");
  const bar = el("div", "lb-bar");
  const title = el("span", "lb-title");
  title.id = "lb-title";
  const save = el("a", "lb-save");
  save.id = "lb-save";
  save.append(icon("file"), el("span", "ic-text", "Save"));
  const close = iconButton("x", "Close", closeLightbox, "lb-close");
  close.setAttribute("aria-label", "close the picture viewer");
  bar.append(title, save, close);

  const stage = el("div", "lb-stage");
  const prev = iconButton("back", "", () => stepLightbox(-1), "lb-prev icon-only");
  prev.setAttribute("aria-label", "previous picture");
  const next = iconButton("back", "", () => stepLightbox(1), "lb-next icon-only");
  next.setAttribute("aria-label", "next picture");
  const img = el("img", "lb-img");
  img.id = "lb-img";
  img.draggable = false;
  stage.append(prev, img, next);
  root.append(bar, stage);
  // clicking the dark part (not the picture or a button) closes it
  root.addEventListener("mousedown", (e) => {
    if (e.target === root || e.target === stage) closeLightbox();
  });
  document.body.append(root);
  lightbox.root = root;
  document.addEventListener("keydown", lightboxKeys, true);
  paintLightbox();
  close.focus();
}

function paintLightbox() {
  const r = lightbox.root;
  if (!r) return;
  const item = lightbox.items[lightbox.at];
  const img = r.querySelector("#lb-img");
  img.src = item.url;
  img.alt = item.name || "picture";
  r.querySelector("#lb-title").textContent = (item.name || "picture") + (lightbox.items.length > 1 ? "  (" + (lightbox.at + 1) + " of " + lightbox.items.length + ")" : "");
  const save = r.querySelector("#lb-save");
  save.href = item.url;
  save.download = item.name || "picture";
  r.querySelector(".lb-prev").hidden = lightbox.at === 0;
  r.querySelector(".lb-next").hidden = lightbox.at === lightbox.items.length - 1;
}
