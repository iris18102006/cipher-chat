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

  media.on(() => {
    grid.replaceChildren();
    if (!add.disabled) status.textContent = media.photos.length + " of " + MAX_PHOTOS;
    for (const photo of media.photos) {
      const item = el("div", "pf-lib-item");
      const pic = el("div", "pic");
      pic.append(pictureImg(photo));
      if (photo.animated) pic.append(el("span", "pf-gif-tag", "GIF"));
      const cap = el("input");
      cap.type = "text";
      cap.maxLength = 60;
      cap.placeholder = "caption (optional)";
      cap.value = photo.caption || "";
      cap.setAttribute("aria-label", "caption");
      // saved on the spot; the list isn't redrawn so tabbing to the next caption keeps working
      cap.onchange = async () => {
        err.textContent = "";
        try {
          const data = await sendJson("/api/me/photos/" + photo.id, "PATCH", { caption: cap.value });
          const saved = data.photos.find((x) => x.id === photo.id);
          if (saved) {
            photo.caption = saved.caption;
            cap.value = saved.caption;
          }
        } catch (ex) {
          err.textContent = ex.message;
        }
      };
      const del = el("button", "", "Remove");
      del.type = "button";
      del.onclick = async () => {
        if (!confirm("Remove this picture? It also comes off your stickers and background.")) return;
        err.textContent = "";
        try {
          media.apply(await sendJson("/api/me/photos/" + photo.id, "DELETE"));
        } catch (ex) {
          err.textContent = ex.message;
        }
      };
      item.append(pic, cap, del);
      grid.append(item);
    }
  });
}

// ---------- editor: background picture ----------

function mountBackgroundEditor(box, media, look, preview) {
  const wrap = el("div");
  box.append(wrap);
  media.on(() => {
    wrap.replaceChildren();
    if (!media.photos.length) {
      wrap.append(el("p", "pf-hint", "Upload a picture in Pictures and GIFs first, then pick it here."));
      return;
    }
    wrap.append(el("p", "pf-hint", "Shows behind your page. Your boxes stay solid so people can still read everything."));
    const fit = choiceRow("Fit");
    const pick = choiceRow("Picture");
    choiceButton(pick.box, "none", !look.bg_image, () => {
      look.bg_image = 0;
      fit.row.hidden = true;
      preview();
    }, "text");
    for (const photo of media.photos) {
      const b = choiceButton(pick.box, "", look.bg_image === photo.id, () => {
        look.bg_image = photo.id;
        fit.row.hidden = false;
        preview();
      }, "thumb");
      b.title = photo.caption || "use as background";
      b.append(pictureImg(photo));
    }
    for (const [value, label] of BG_MODES) {
      choiceButton(fit.box, label, (look.custom.bg_mode || "tile") === value, () => {
        look.custom.bg_mode = value;
        preview();
      }, "text");
    }
    fit.row.hidden = !look.bg_image;
    wrap.append(pick.row, fit.row);
  });
}

// ---------- editor: stickers ----------

// what the little board shows, to help you picture where things land: [name, how tall]
const BOARD_BLOCKS = [
  ["picture and name", 14], ["about me", 16], ["interests", 10],
  ["pictures", 16], ["top friends", 14], ["wall", 22],
];
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function mountStickerEditor(box, media, look) {
  const wrap = el("div");
  box.append(wrap);
  let selected = null; // the sticker object being edited

  const urlOf = (id) => {
    const photo = media.photos.find((x) => x.id === id);
    return photo ? photo.url : "";
  };

  function paint() {
    wrap.replaceChildren();
    if (!media.photos.length) {
      wrap.append(el("p", "pf-hint", "Upload a picture or GIF in Pictures and GIFs first, then stick it on your profile here."));
      return;
    }
    if (selected && !look.stickers.includes(selected)) selected = null;
    wrap.append(el("p", "pf-hint", "Tap a picture to stick it on, then drag it where you want it. The board is a small copy of your page. Up to " + MAX_STICKERS + " stickers, and they need Save."));

    // the pictures you can stick on
    const pick = el("div", "pf-pick");
    for (const photo of media.photos) {
      const b = el("button", "pf-choice thumb");
      b.type = "button";
      b.title = photo.caption || "add as a sticker";
      b.append(pictureImg(photo));
      b.disabled = look.stickers.length >= MAX_STICKERS;
      b.onclick = () => {
        look.stickers.push({ img: photo.id, x: 50, y: 30, w: 22, r: 0 });
        selected = look.stickers[look.stickers.length - 1];
        paint();
      };
      pick.append(b);
    }
    wrap.append(pick);

    // the board
    const board = el("div", "pf-board");
    for (const [label, grow] of BOARD_BLOCKS) {
      const block = el("div", "pf-board-block", label);
      block.style.flexGrow = String(grow);
      board.append(block);
    }
    board.onpointerdown = (e) => {
      if (e.target === board || e.target.classList.contains("pf-board-block")) select(null, null);
    };
    wrap.append(board);

    // size and tilt of the selected sticker
    const ctl = el("div", "pf-sticker-controls");
    const sliders = {};
    function slider(label, key, min, max) {
      const row = el("label", "pf-style-row");
      const value = el("b");
      const left = el("span");
      left.append(label + " ", value);
      const input = el("input");
      input.type = "range";
      input.min = String(min);
      input.max = String(max);
      input.oninput = () => {
        if (!selected) return;
        selected[key] = Number(input.value);
        value.textContent = input.value;
        const node = board.querySelector(".pf-sticker.selected");
        if (node) placeSticker(node, selected);
      };
      row.append(left, input);
      ctl.append(row);
      sliders[key] = { input, value };
    }
    slider("Size", "w", 4, 45);
    slider("Tilt", "r", -45, 45);
    const remove = el("button", "", "Remove this sticker");
    remove.type = "button";
    remove.onclick = () => {
      if (!selected) return;
      look.stickers.splice(look.stickers.indexOf(selected), 1);
      selected = null;
      paint();
    };
    ctl.append(remove);
    wrap.append(ctl);

    function syncControls() {
      for (const key of Object.keys(sliders)) {
        const { input, value } = sliders[key];
        input.disabled = !selected;
        input.value = String(selected ? selected[key] : key === "w" ? 22 : 0);
        value.textContent = input.value;
      }
      remove.disabled = !selected;
    }

    // pick a sticker (or nothing); the one you pick goes on top of the others
    function select(s, node) {
      selected = s;
      if (s && node) {
        look.stickers.splice(look.stickers.indexOf(s), 1);
        look.stickers.push(s);
        board.append(node);
      }
      for (const n of board.querySelectorAll(".pf-sticker")) n.classList.toggle("selected", n === node);
      syncControls();
    }

    function addSticker(s) {
      const img = el("img", "pf-sticker");
      img.src = safeImg(urlOf(s.img));
      img.alt = "sticker";
      img.draggable = false;
      img.tabIndex = 0;
      placeSticker(img, s);
      if (s === selected) img.classList.add("selected");

      img.onpointerdown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        select(s, img);
        const rect = board.getBoundingClientRect();
        // keep the spot you grabbed under your finger instead of jumping to the centre
        const dx = ((e.clientX - rect.left) / rect.width) * 100 - s.x;
        const dy = ((e.clientY - rect.top) / rect.height) * 100 - s.y;
        img.setPointerCapture(e.pointerId);
        img.onpointermove = (ev) => {
          s.x = clamp(((ev.clientX - rect.left) / rect.width) * 100 - dx, 0, 100);
          s.y = clamp(((ev.clientY - rect.top) / rect.height) * 100 - dy, 0, 100);
          placeSticker(img, s);
        };
        const stop = () => (img.onpointermove = null);
        img.onpointerup = stop;
        img.onpointercancel = stop;
      };
      // keyboard: arrows nudge it, Delete removes it
      img.onkeydown = (e) => {
        const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
        if (step) {
          e.preventDefault();
          select(s, null);
          img.classList.add("selected");
          s.x = clamp(s.x + step[0], 0, 100);
          s.y = clamp(s.y + step[1], 0, 100);
          placeSticker(img, s);
        } else if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          look.stickers.splice(look.stickers.indexOf(s), 1);
          selected = null;
          paint();
        }
      };
      board.append(img);
    }

    for (const s of look.stickers) addSticker(s);
    syncControls();
  }

  media.on(paint);
}
