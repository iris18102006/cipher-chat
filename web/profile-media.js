// Pictures on profiles: the profile photo, a gallery of photos and gifs, a background
// picture and stickers you drag around. Loaded after profile.js, which provides
// avatarNode, safeImg, choiceRow, choiceButton, pfCurrent and shownName.
//
// Nothing a user uploads is ever put in the page as html. Pictures are only shown through
// <img> tags whose src is /api/img/<number>, and the server only serves real png/jpg/gif/webp.

const PICTURE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const PICTURE_ACCEPT = PICTURE_TYPES.join(",");
const MAX_PHOTOS = 12;
const MAX_STICKERS = 8;
const AVATAR_MAX_MB = 5;
const PHOTO_MAX_MB = 4;

// ---------- talking to the server ----------

async function mediaReply(res) {
  if (res.status === 401) {
    location.href = "/login.html";
    throw new Error("not logged in");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "that didn't work, try again");
  return data;
}

function sendFile(path, method, file) {
  return fetch(path, { method, headers: { "Content-Type": "application/octet-stream" }, body: file }).then(mediaReply);
}

function sendJson(path, method, obj) {
  const opts = { method };
  if (obj !== undefined) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(obj);
  }
  return fetch(path, opts).then(mediaReply);
}

// quick check before uploading so a wrong file fails fast (the server checks again, for real)
function checkPicture(file, maxMb) {
  if (!PICTURE_TYPES.includes(file.type)) return "use a png, jpg, gif or webp picture";
  if (file.size > maxMb * 1024 * 1024) return "too big (max " + maxMb + " MB)";
  return "";
}

// The pictures part of the editor. Photos are saved on the server the moment you upload
// or remove them. Everything else (colours, stickers...) waits for the Save button.
// Parts of the editor register with media.on(fn) and get redrawn whenever pictures change.
function makeMedia(p) {
  const listeners = [];
  const m = {
    avatar: p.avatar || "",
    photos: (p.photos || []).slice(),
    on(fn) {
      listeners.push(fn);
      fn();
    },
    refresh() {
      for (const fn of listeners) fn();
    },
    // the server answers every picture change with the new state of everything picture related
    apply(data) {
      m.avatar = data.avatar;
      m.photos = data.photos;
      const fields = {
        avatar: data.avatar, photos: data.photos, stickers: data.stickers,
        bg_image: data.bg_image, bg_url: data.bg_url,
      };
      Object.assign(p, fields);
      if (pfCurrent && pfCurrent !== p) Object.assign(pfCurrent, fields);
      m.refresh();
    },
  };
  return m;
}

function pictureImg(photo) {
  const img = el("img");
  img.src = safeImg(photo.url);
  img.alt = photo.caption || "picture";
  img.draggable = false;
  return img;
}

// ---------- on a profile: gallery, full size view, stickers ----------

function gallerySection(p) {
  const box = el("div", "pf-section");
  box.append(el("h3", "", "Pictures"));
  const grid = el("div", "pf-gallery");
  p.photos.forEach((photo, i) => {
    const fig = el("figure", "pf-photo");
    fig.tabIndex = 0;
    const img = pictureImg(photo);
    img.loading = "lazy";
    fig.append(img);
    if (photo.animated) fig.append(el("span", "pf-gif-tag", "GIF"));
    if (photo.caption) fig.append(el("figcaption", "", photo.caption));
    const open = () => openLightbox(p.photos, i);
    fig.onclick = open;
    fig.onkeydown = (e) => {
      if (e.key === "Enter") open();
    };
    grid.append(fig);
  });
  box.append(grid);
  return box;
}

let lightboxClose = null;

function openLightbox(photos, start) {
  if (lightboxClose) lightboxClose();
  const returnTo = document.activeElement;
  let i = start;
  const box = el("div");
  box.id = "pf-lightbox";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  const img = el("img");
  const cap = el("div", "cap");
  const nav = el("div", "nav");
  const prev = el("button", "", "Previous");
  const next = el("button", "", "Next");
  const close = el("button", "", "Close");
  for (const b of [prev, next, close]) b.type = "button";
  nav.append(prev, next, close);
  box.append(img, cap, nav);

  const show = () => {
    const photo = photos[i];
    img.src = safeImg(photo.url);
    img.alt = photo.caption || "picture";
    cap.textContent = photo.caption || "";
    prev.disabled = i === 0;
    next.disabled = i === photos.length - 1;
  };
  const go = (step) => {
    const to = i + step;
    if (to >= 0 && to < photos.length) {
      i = to;
      show();
    }
  };
  const onKey = (e) => {
    // runs before the profile's own Escape handler, so Escape only closes the picture
    if (e.key === "Escape") {
      e.stopPropagation();
      closeBox();
    } else if (e.key === "ArrowLeft") go(-1);
    else if (e.key === "ArrowRight") go(1);
  };
  function closeBox() {
    document.removeEventListener("keydown", onKey, true);
    box.remove();
    lightboxClose = null;
    if (returnTo && document.contains(returnTo)) returnTo.focus();
  }
  lightboxClose = closeBox;
  prev.onclick = () => go(-1);
  next.onclick = () => go(1);
  close.onclick = closeBox;
  box.onclick = (e) => {
    if (e.target === box) closeBox();
  };
  document.addEventListener("keydown", onKey, true);
  document.body.append(box);
  show();
  close.focus();
}

function placeSticker(img, s) {
  img.style.left = Number(s.x) + "%";
  img.style.top = Number(s.y) + "%";
  img.style.width = Number(s.w) + "%";
  img.style.transform = "translate(-50%, -50%) rotate(" + Number(s.r || 0) + "deg)";
}

// stickers sit on top of the whole profile; x, y and w are percentages of the page
function stickerLayer(stickers) {
  const layer = el("div", "pf-stickers");
  layer.setAttribute("aria-hidden", "true");
  for (const s of stickers || []) {
    const url = safeImg(s.url);
    if (!url) continue;
    const img = el("img", "pf-sticker");
    img.src = url;
    img.alt = "";
    img.draggable = false;
    placeSticker(img, s);
    layer.append(img);
  }
  return layer;
}

// ---------- editor: profile picture ----------

function mountAvatarEditor(box, p, media) {
  const row = el("div", "pf-avatar-edit");
  const holder = el("div");
  const side = el("div", "pf-avatar-side");
  const bar = el("div", "pf-actions");
  const file = el("input");
  file.type = "file";
  file.accept = PICTURE_ACCEPT;
  file.hidden = true;
  const upload = el("button");
  upload.type = "button";
  upload.onclick = () => file.click();
  const remove = el("button", "", "Remove photo");
  remove.type = "button";
  const note = el("p", "pf-hint");
  const HINT = "We crop it to a square. A photo is saved the moment you upload it, no need to press Save for that.";
  const err = el("span", "pf-inline-error");
  bar.append(upload, remove);
  side.append(bar, note, err);
  row.append(holder, side, file);
  box.append(row);

  file.onchange = async () => {
    const f = file.files[0];
    file.value = "";
    if (!f) return;
    err.textContent = "";
    const bad = checkPicture(f, AVATAR_MAX_MB);
    if (bad) {
      err.textContent = bad;
      return;
    }
    upload.disabled = remove.disabled = true;
    note.textContent = "uploading...";
    try {
      media.apply(await sendFile("/api/me/avatar", "PUT", f));
    } catch (ex) {
      err.textContent = ex.message;
    }
    upload.disabled = remove.disabled = false;
    note.textContent = HINT;
  };
  remove.onclick = async () => {
    err.textContent = "";
    try {
      media.apply(await sendJson("/api/me/avatar", "DELETE"));
    } catch (ex) {
      err.textContent = ex.message;
    }
  };

  media.on(() => {
    holder.replaceChildren(avatarNode({ ...p, avatar: media.avatar }));
    upload.textContent = media.avatar ? "Change photo" : "Upload a photo";
    remove.hidden = !media.avatar;
    note.textContent = HINT;
  });
}

// ---------- editor: the picture library ----------

function mountLibraryEditor(box, media) {
  box.append(el("p", "pf-hint", "Photos and GIFs for your profile (png, jpg, gif or webp, up to " + MAX_PHOTOS + "). GIFs keep moving. Saved right away."));
  const bar = el("div", "pf-actions");
  const file = el("input");
  file.type = "file";
  file.accept = PICTURE_ACCEPT;
  file.multiple = true;
  file.hidden = true;
  const add = el("button", "", "Upload pictures or GIFs");
  add.type = "button";
  add.onclick = () => file.click();
  const status = el("span", "pf-hint");
  const err = el("div", "pf-error");
  err.style.padding = "0 0 6px";
  err.style.textAlign = "left";
  bar.append(add, status, file);
  const grid = el("div", "pf-lib");
  box.append(bar, err, grid);

  file.onchange = async () => {
    const files = [...file.files];
    file.value = "";
    err.textContent = "";
    add.disabled = true;
    const problems = [];
    for (let n = 0; n < files.length; n++) {
      const f = files[n];
      if (media.photos.length >= MAX_PHOTOS) {
        problems.push("that's the limit, remove a picture to add more");
        break;
      }
      const bad = checkPicture(f, PHOTO_MAX_MB);
      if (bad) {
        problems.push(f.name + ": " + bad);
        continue;
      }
      status.textContent = "uploading " + (n + 1) + " of " + files.length + "...";
      try {
        media.apply(await sendFile("/api/me/photos", "POST", f));
      } catch (ex) {
        problems.push(f.name + ": " + ex.message);
      }
    }
    err.textContent = problems.join(" / ");
    add.disabled = false;
    status.textContent = media.photos.length + " of " + MAX_PHOTOS;
  };
