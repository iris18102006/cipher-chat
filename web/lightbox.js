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

function stepLightbox(by) {
  const to = lightbox.at + by;
  if (to < 0 || to >= lightbox.items.length) return;
  lightbox.at = to;
  paintLightbox();
}

function lightboxKeys(e) {
  if (!lightbox.root) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeLightbox();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    stepLightbox(-1);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    stepLightbox(1);
  }
}

function closeLightbox() {
  if (!lightbox.root) return;
  lightbox.root.remove();
  lightbox.root = null;
  lightbox.items = [];
  document.removeEventListener("keydown", lightboxKeys, true);
  const back = lightbox.returnFocus;
  lightbox.returnFocus = null;
  if (back && document.contains(back)) back.focus();
}

// the pictures that are showing in the open chat, in order, with the one that was clicked
function chatPictures(clicked) {
  const imgs = [...document.querySelectorAll("#messages .att-image img")];
  const items = imgs.map((n) => ({ url: n.src, name: n.alt }));
  const at = Math.max(0, imgs.indexOf(clicked));
  return { items: items.length ? items : [{ url: clicked.src, name: clicked.alt }], at: items.length ? at : 0 };
}
