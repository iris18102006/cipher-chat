// Profile page: look at anyone's profile, edit your own.
// Loaded after app.js, which provides $, el, api, state, parseTs and lastSeenText.
// The picture parts (profile photo, gallery, background, stickers) are in profile-media.js.

function shownName(p) {
  return p.display_name || p.username;
}

// pictures are only ever served from our own /api/img/<number>, nothing else goes in a src
function safeImg(url) {
  return typeof url === "string" && /^\/api\/img\/\d+$/.test(url) ? url : "";
}

// the photo they uploaded, or the first letter of their name if they haven't uploaded one
function avatarNode(p, size) {
  const box = el("div", "pf-avatar" + (size ? " " + size : ""));
  const letter = () => box.replaceChildren(el("span", "pf-avatar-letter", Array.from(shownName(p))[0].toUpperCase()));
  const url = safeImg(p.avatar);
  if (url) {
    const img = el("img");
    img.src = url;
    img.alt = "";
    img.draggable = false;
    img.onerror = letter; // deleted, or its owner blocked you
    box.append(img);
  } else {
    letter();
  }
  return box;
}

let pfCurrent = null; // the profile that is open right now
let pfReturnFocus = null; // what had focus before the page opened

// ---------- open / close ----------

function closeProfile() {
  $("profile-overlay").hidden = true;
  pfCurrent = null;
  // put the keyboard back where it was
  if (pfReturnFocus && document.contains(pfReturnFocus)) pfReturnFocus.focus();
  pfReturnFocus = null;
}

async function openProfile(username) {
  if ($("profile-overlay").hidden) {
    pfReturnFocus = document.activeElement;
    $("profile-overlay").hidden = false;
    $("pf-close").focus();
  }
  $("pf-body").replaceChildren(el("p", "pf-error", "loading..."));
  try {
    const p = await api("/api/profile/" + encodeURIComponent(username));
    pfCurrent = p;
    renderProfile(p);
  } catch {
    pfCurrent = null;
    $("pf-body").replaceChildren(el("p", "pf-error", "this profile isn't available."));
  }
}

// ---------- the look: themes, colours, fonts, shapes ----------

const CUSTOM_COLOR_VARS = {
  page: "--p-page", card: "--p-card", text: "--p-text", head_a: "--p-head-a",
  head_b: "--p-head-b", head_text: "--p-head-text", border: "--p-border",
};
const COLOR_FIELDS = [
  ["page", "Page"], ["card", "Boxes"], ["text", "Text"], ["head_a", "Header 1"],
  ["head_b", "Header 2"], ["head_text", "Header text"], ["border", "Borders"],
];
// [id, label, css font stack]. The ids match CUSTOM_CHOICES["font"] in backend/main.py.
// The font is set on the card itself (not with a class) so it always beats the theme's own font.
const FONT_CHOICES = [
  ["verdana", "Verdana", "Verdana, Tahoma, sans-serif"],
  ["arial", "Arial", "Arial, Helvetica, sans-serif"],
  ["trebuchet", "Trebuchet", '"Trebuchet MS", Verdana, sans-serif'],
  ["comic", "Comic Sans", '"Comic Sans MS", "Chalkboard SE", cursive'],
  ["georgia", "Georgia", 'Georgia, "Times New Roman", serif'],
  ["times", "Times", '"Times New Roman", Times, serif'],
  ["palatino", "Palatino", '"Palatino Linotype", Palatino, "Book Antiqua", serif'],
  ["courier", "Courier", '"Courier New", monospace'],
  ["lucida", "Lucida", '"Lucida Console", "Lucida Sans Typewriter", Monaco, monospace'],
  ["impact", "Impact", 'Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif'],
  ["script", "Script", '"Brush Script MT", "Segoe Script", "Lucida Handwriting", cursive'],
];
const PATTERNS = [
  ["none", "None"], ["dots", "Dots"], ["stripes", "Stripes"], ["checks", "Checks"],
  ["grid", "Grid"], ["diagonal", "Diagonal"], ["stars", "Stars"], ["hearts", "Hearts"],
];
const BORDER_STYLES = [
  ["solid", "Solid"], ["dashed", "Dashed"], ["dotted", "Dotted"],
  ["double", "Double"], ["ridge", "Ridge"], ["groove", "Groove"],
];
const NAME_EFFECTS = [["none", "None"], ["glow", "Glow"], ["shadow", "Shadow"], ["rainbow", "Rainbow"]];
const AVATAR_SHAPES = [
  ["circle", "Circle"], ["rounded", "Rounded"], ["square", "Square"],
  ["diamond", "Diamond"], ["hexagon", "Hexagon"],
];
const BG_MODES = [["tile", "Tile it"], ["cover", "Fill the page"], ["center", "Centre"]];

// look = { theme, accent, custom, bg_url }. A profile from the server has all of those.
function applyTheme(card, look) {
  const custom = look.custom || {};
  card.className = "theme-" + (look.theme || "classic");
  for (const variable of [
    ...Object.values(CUSTOM_COLOR_VARS), "--p-accent", "--p-font",
    "--p-border-width", "--p-radius", "--p-border-style",
  ]) {
    card.style.removeProperty(variable);
  }
  for (const prop of ["background-image", "background-size", "background-repeat", "background-position"]) {
    card.style.removeProperty(prop);
  }

  if (look.accent) card.style.setProperty("--p-accent", look.accent);
  for (const [key, variable] of Object.entries(CUSTOM_COLOR_VARS)) {
    if (custom[key]) card.style.setProperty(variable, custom[key]);
  }
  const font = FONT_CHOICES.find((f) => f[0] === custom.font);
  if (font) card.style.setProperty("--p-font", font[2]);
  if (custom.pattern && custom.pattern !== "none") card.classList.add("pattern-" + custom.pattern);
  if (custom.name_effect && custom.name_effect !== "none") card.classList.add("name-" + custom.name_effect);
  if (custom.avatar_shape) card.classList.add("av-" + custom.avatar_shape);
  if (custom.marquee) card.classList.add("pf-marquee");
  if (Number.isInteger(custom.border_width)) card.style.setProperty("--p-border-width", custom.border_width + "px");
  if (Number.isInteger(custom.radius)) card.style.setProperty("--p-radius", custom.radius + "px");
  if (custom.border_style) card.style.setProperty("--p-border-style", custom.border_style);

  // a background picture goes over the pattern
  const bg = safeImg(look.bg_url);
  if (bg) {
    const mode = custom.bg_mode || "tile";
    card.style.backgroundImage = 'url("' + bg + '")';
    card.style.backgroundRepeat = mode === "tile" ? "repeat" : "no-repeat";
    card.style.backgroundSize = mode === "cover" ? "cover" : "auto";
    card.style.backgroundPosition = mode === "tile" ? "0 0" : "center top";
  }
}

// ---------- viewing ----------

function section(title, text) {
  const box = el("div", "pf-section");
  box.append(el("h3", "", title));
  const body = el("div", "pf-content" + (text ? "" : " empty"), text || "nothing here yet");
  box.append(body);
  return box;
}

function topFriendsSection(p) {
  const box = el("div", "pf-section");
  box.append(el("h3", "", "Top friends"));
  if (!p.top_friends.length) {
    box.append(el("div", "pf-content empty", "pick up to 8 friends with Edit profile"));
    return box;
  }
  const grid = el("div", "pf-top");
  for (const f of p.top_friends) {
    const item = el("div", "pf-top-item");
    item.tabIndex = 0;
    item.append(avatarNode(f, "small"), el("span", "", shownName(f)));
    const open = () => openProfile(f.username);
    item.onclick = open;
    item.onkeydown = (e) => {
      if (e.key === "Enter") open();
    };
    grid.append(item);
  }
  box.append(grid);
  return box;
}

function stat(label, value) {
  const s = el("span");
  s.append(el("b", "", String(value)), " " + label);
  return s;
}

function wallSection(p) {
  const box = el("div", "pf-section pf-wall");
  box.append(el("h3", "", "Profile wall"));

  const form = el("form", "pf-wall-form");
  const input = el("textarea");
  input.maxLength = 300;
  input.rows = 3;
  input.placeholder = p.me ? "write something on your wall..." : "leave a comment...";
  const send = el("button", "", "Post");
  send.type = "submit";
  const err = el("span", "pf-inline-error");
  form.append(input, send, err);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    send.disabled = true; err.textContent = "";
    try {
      await api("/api/profile/" + encodeURIComponent(p.username) + "/wall", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }),
      });
      await openProfile(p.username);
    } catch {
      err.textContent = "couldn't post comment";
      send.disabled = false;
    }
  };
  box.append(form);

  const list = el("div", "pf-wall-list");
  if (!p.wall || !p.wall.length) {
    list.append(el("div", "pf-content empty", "no comments yet"));
  } else {
    for (const c of p.wall) {
      const item = el("div", "pf-wall-item");
      const head = el("div", "pf-wall-head");
      const who = el("button", "pf-wall-who");
      who.type = "button";
      who.append(avatarNode(c, "tiny"), shownName(c));
      who.onclick = () => openProfile(c.username);
      head.append(who, el("span", "", parseTs(c.created_at).toLocaleString()));
      if (c.mine || p.me) {
        const del = el("button", "pf-wall-delete", "delete");
        del.type = "button";
        del.onclick = async () => {
          try {
            await api("/api/profile/" + encodeURIComponent(p.username) + "/wall/" + c.id, { method: "DELETE" });
            await openProfile(p.username);
          } catch {}
        };
        head.append(del);
      }
      item.append(head, el("div", "pf-wall-body", c.body));
      list.append(item);
    }
  }
  box.append(list);
  return box;
}

function renderProfile(p) {
  applyTheme($("profile-card"), p);
  $("pf-title").textContent = p.me ? "My profile" : shownName(p) + "'s profile";
  const body = $("pf-body");
  body.replaceChildren();

  const hero = el("div", "pf-hero");
  hero.append(avatarNode(p));
  const who = el("div", "pf-who");
  who.append(el("h2", "pf-name", shownName(p)));
  who.append(el("div", "pf-handle", "@" + p.username));
  if (p.mood) who.append(el("div", "pf-mood", "mood: " + p.mood));
  if (p.headline) who.append(el("div", "pf-headline", p.headline));
  const presence = el("div", "pf-presence");
  presence.append(el("span", "dot " + (p.online ? "on" : "off")), lastSeenText(p));
  who.append(presence);
  hero.append(who);
  body.append(hero);

  // buttons (add friend, block...) get added to this row by their own features
  const actions = el("div", "pf-actions");
  if (p.me) {
    const edit = el("button", "", "Edit profile");
    edit.type = "button";
    edit.onclick = () => renderEditor(p);
    actions.append(edit);
  }
  addSocialButtons(p, actions);
  body.append(actions);

  body.append(section("About me", p.about_me));
  body.append(section("Interests", p.interests));
  if (p.song) body.append(section("Now playing", p.song));
  if (p.photos.length) body.append(gallerySection(p));
  else if (p.me) body.append(section("Pictures", ""));
  if (p.top_friends.length || p.me) body.append(topFriendsSection(p));
  if (p.location) body.append(section("Location", p.location));
  body.append(wallSection(p));

  const stats = el("div", "pf-stats");
  stats.append(stat("friends", p.friend_count));
  stats.append(stat("profile visitors", p.visitors));
  if (!p.me) stats.append(stat("mutual friends", p.mutual_friends));
  stats.append(el("span", "", "joined " + parseTs(p.joined).toLocaleDateString()));
  body.append(stats);

  body.append(stickerLayer(p.stickers));
}

// ---------- editing ----------

// [field, label, max length, multiline, placeholder]
const TEXT_FIELDS = [
  ["display_name", "Display name", 30, false, "what your friends call you"],
  ["mood", "Mood", 40, false, "like: sleepy"],
  ["headline", "Headline", 80, false, "a short line under your name"],
  ["about_me", "About me", 600, true, "tell people who you are"],
  ["interests", "Interests", 200, false, "music, games, anything"],
  ["location", "Location", 40, false, "where are you from?"],
  ["song", "Now playing", 80, false, "artist - song"],
];

function textRow(container, [field, label, max, multiline, hint], value) {
  const row = el("div", "pf-row");
  const id = "pf-in-" + field;
  const lab = el("label", "", label);
  lab.htmlFor = id;
  const input = el(multiline ? "textarea" : "input");
  input.id = id;
  input.name = field;
  input.maxLength = max;
  input.placeholder = hint;
  input.value = value || "";
  if (multiline) input.rows = 5;
  else input.type = "text";
  const count = el("span", "pf-count");
  const update = () => (count.textContent = input.value.length + "/" + max);
  input.addEventListener("input", update);
  update();
  row.append(lab, input, count);
  container.append(row);
  return input;
}

// [id, label], ids match THEMES in backend/main.py
const THEME_CHOICES = [
  ["classic", "Classic"], ["emo", "Emo"], ["kawaii", "Kawaii"], ["neon", "Neon"],
  ["forest", "Forest"], ["sunset", "Sunset"], ["gothic", "Gothic"], ["terminal", "Terminal"],
];
const ACCENTS = ["#ff9933", "#ff2e93", "#39ff14", "#00b7ff", "#7a2cff", "#e6b800", "#e63946", "#2ec27e"];

// a row of buttons where exactly one is selected
function choiceRow(title, hint) {
  const row = el("div", "pf-row wide");
  row.append(el("label", "", title));
  const box = el("div", "pf-picker");
  row.append(box);
  if (hint) row.append(el("span", "pf-count", hint));
  return { row, box };
}

function choiceButton(box, label, selected, onPick, extraClass, value) {
  const b = el("button", "pf-choice" + (extraClass ? " " + extraClass : "") + (selected ? " on" : ""), label);
  b.type = "button";
  if (value !== undefined) b.dataset.value = value;
  b.onclick = () => {
    for (const other of box.children) other.classList.remove("on");
    b.classList.add("on");
    onPick();
  };
  box.append(b);
  return b;
}

async function saveProfile(changes) {
  const res = await fetch("/api/profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes),
  });
  if (res.status === 401) {
    location.href = "/login.html";
    throw new Error("not logged in");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data.detail === "string" ? data.detail : "couldn't save, try again");
  }
  return data;
}

// the colour a theme (or a custom colour) is really using right now, for the colour pickers
function effectiveColor(key) {
  const raw = getComputedStyle($("profile-card")).getPropertyValue(CUSTOM_COLOR_VARS[key]).trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(raw)) return raw;
  if (/^#[0-9a-f]{3}$/.test(raw)) return "#" + [...raw.slice(1)].map((c) => c + c).join("");
  return "#000000";
}

const round2 = (n) => Math.round(n * 100) / 100;

function renderEditor(p) {
  const body = $("pf-body");
  body.replaceChildren();
  const card = $("profile-card");
  const form = el("form", "pf-form");
  form.autocomplete = "off";
  const inputs = {};

  // what's picked so far, applied to the card live so you see it before saving
  const look = {
    theme: p.theme,
    accent: p.accent,
    custom: { ...(p.custom || {}) },
    bg_image: p.bg_image || 0,
    stickers: (p.stickers || []).map((s) => ({ img: s.img, x: s.x, y: s.y, w: s.w, r: s.r })),
  };
  const media = makeMedia(p);
  const bgUrl = () => {
    const ph = media.photos.find((x) => x.id === look.bg_image);
    return ph ? ph.url : "";
  };
  const preview = () => applyTheme(card, { theme: look.theme, accent: look.accent, custom: look.custom, bg_url: bgUrl() });
  // everything that has to be redrawn when the look changes behind its back (theme pick, reset)
  const syncers = [];
  const syncAll = () => syncers.forEach((fn) => fn());

  // deleting a picture also takes it out of your unsaved stickers and background
  media.on(() => {
    const ids = new Set(media.photos.map((x) => x.id));
    look.stickers = look.stickers.filter((s) => ids.has(s.img));
    if (look.bg_image && !ids.has(look.bg_image)) look.bg_image = 0;
    preview();
  });

  function group(title) {
    const box = el("details", "pf-group");
    box.open = true;
    box.append(el("summary", "", title));
    const inner = el("div", "pf-group-body");
    box.append(inner);
    form.append(box);
    return inner;
  }

  // ---- save / cancel (at the top and the bottom, the page is long)
  const err = el("p", "pf-error");
  const saveButtons = [];
  function actionBar() {
    const bar = el("div", "pf-actions");
    const save = el("button", "", "Save");
    save.type = "submit";
    const cancel = el("button", "", "Cancel");
    cancel.type = "button";
    cancel.onclick = () => renderProfile(pfCurrent);
    bar.append(save, cancel);
    saveButtons.push(save);
    return bar;
  }
  form.append(actionBar());

  // ---- about you
  const about = group("About you");
  for (const f of TEXT_FIELDS) inputs[f[0]] = textRow(about, f, p[f[0]]);

  // ---- profile picture
  mountAvatarEditor(group("Profile picture"), p, media);

  // ---- theme and colours
  const looks = group("Theme and colours");
  const th = choiceRow("Theme", "colours reset to match");
  th.box.classList.add("pf-themes");
  const colorInputs = {};
  for (const [id, label] of THEME_CHOICES) {
    const b = el("button", "pf-theme-btn" + (look.theme === id ? " on" : ""));
    b.type = "button";
    b.append(el("span", "pf-swatch theme-" + id), label);
    b.onclick = () => {
      look.theme = id;
      // a theme brings its own colours; leftovers from the old one would hide it
      for (const key of Object.keys(CUSTOM_COLOR_VARS)) delete look.custom[key];
      for (const other of th.box.children) other.classList.toggle("on", other === b);
      preview();
      syncAll();
    };
    th.box.append(b);
  }
  looks.append(th.row);

  const ac = choiceRow("Accent colour", "optional");
  choiceButton(ac.box, "theme's own", !look.accent, () => {
    look.accent = "";
    preview();
  }, "text");
  for (const color of ACCENTS) {
    const b = choiceButton(ac.box, "", look.accent === color, () => {
      look.accent = color;
      preview();
    }, "swatch");
    b.style.background = color;
    b.title = color;
    b.setAttribute("aria-label", "accent " + color);
  }
  looks.append(ac.row);

  const colors = el("div", "pf-style-grid");
  for (const [key, label] of COLOR_FIELDS) {
    const wrap = el("label", "pf-style-color");
    wrap.append(el("span", "", label));
    const input = el("input");
    input.type = "color";
    input.oninput = () => {
      look.custom[key] = input.value;
      preview();
    };
    colorInputs[key] = input;
    wrap.append(input);
    colors.append(wrap);
  }
  syncers.push(() => {
    for (const key of Object.keys(colorInputs)) colorInputs[key].value = effectiveColor(key);
  });
  looks.append(colors);

  const reset = el("button", "pf-reset-style", "Reset fonts, shapes and colours");
  reset.type = "button";
  reset.onclick = () => {
    look.custom = {};
    preview();
    syncAll();
    media.refresh();
  };
  looks.append(reset);

  // ---- fonts and shapes
  const shapes = group("Fonts and shapes");

  // a row of buttons for one style option. "" as a value means "not set" (the theme decides).
  function enumRow(title, key, choices, fallback, decorate) {
    const r = choiceRow(title);
    for (const [value, label] of choices) {
      const b = choiceButton(r.box, label, false, () => {
        if (value === "") delete look.custom[key];
        else look.custom[key] = value;
        preview();
      }, "text", value);
      if (decorate) decorate(b, value);
    }
    syncers.push(() => {
      const now = look.custom[key] || fallback;
      for (const b of r.box.children) b.classList.toggle("on", b.dataset.value === now);
    });
    shapes.append(r.row);
  }

  enumRow("Font", "font", [["", "Theme's own"], ...FONT_CHOICES], "", (b, value) => {
    const font = FONT_CHOICES.find((f) => f[0] === value);
    if (font) b.style.fontFamily = font[2];
  });
  enumRow("Name style", "name_effect", NAME_EFFECTS, "none");
  enumRow("Picture shape", "avatar_shape", AVATAR_SHAPES, "circle", (b, value) => {
    b.classList.add("with-icon");
    b.prepend(el("span", "pf-shape shape-" + value));
  });
  enumRow("Border style", "border_style", BORDER_STYLES, "solid");
  enumRow("Background pattern", "pattern", PATTERNS, "none");

  function rangeRow(label, key, min, max, fallback) {
    const row = el("label", "pf-style-row");
    const value = el("b");
    const left = el("span");
    left.append(label + " ", value);
    const input = el("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.oninput = () => {
      look.custom[key] = Number(input.value);
      value.textContent = input.value;
      preview();
    };
    syncers.push(() => {
      input.value = String(look.custom[key] ?? fallback);
      value.textContent = input.value;
    });
    row.append(left, input);
    shapes.append(row);
  }
  rangeRow("Border width", "border_width", 0, 6, 2);
  rangeRow("Corner roundness", "radius", 0, 24, 0);

  const marquee = el("label", "pf-style-row check");
  const marqueeInput = el("input");
  marqueeInput.type = "checkbox";
  marqueeInput.onchange = () => {
    look.custom.marquee = marqueeInput.checked;
    preview();
  };
  syncers.push(() => (marqueeInput.checked = !!look.custom.marquee));
  marquee.append(el("span", "", "Scrolling display name"), marqueeInput);
  shapes.append(marquee);

  // ---- pictures, background, stickers (profile-media.js)
  mountLibraryEditor(group("Pictures and GIFs"), media);
  mountBackgroundEditor(group("Background picture"), media, look, preview);
  mountStickerEditor(group("Stickers"), media, look);

  // ---- top friends: tap friends in the order you want them, up to 8
  const top = (p.top_friends || []).map((f) => f.username);
  const tf = choiceRow("Top friends", "max 8");
  tf.box.textContent = "loading...";
  group("Top friends").append(tf.row);
  api("/api/friends")
    .then(({ friends }) => {
      const paint = () => {
        tf.box.replaceChildren();
        if (!friends.length) {
          tf.box.textContent = "add some friends first, then pick your top 8 here";
          return;
        }
        for (const f of friends) {
          const at = top.indexOf(f.username);
          const b = el("button", "pf-choice text with-avatar" + (at >= 0 ? " on" : ""));
          b.type = "button";
          b.append(avatarNode(f, "tiny"), (at >= 0 ? at + 1 + ". " : "") + shownName(f));
          b.onclick = () => {
            if (at >= 0) top.splice(at, 1);
            else if (top.length < 8) top.push(f.username);
            paint();
          };
          tf.box.append(b);
        }
      };
      paint();
      tf.box.dataset.ready = "1";
    })
    .catch(() => (tf.box.textContent = "couldn't load your friends"));

  form.append(err, actionBar());

  form.onsubmit = async (e) => {
    e.preventDefault();
    err.textContent = "";
    for (const b of saveButtons) b.disabled = true;
    const changes = {};
    for (const [field] of TEXT_FIELDS) changes[field] = inputs[field].value;
    changes.theme = look.theme;
    changes.accent = look.accent || "";
    changes.custom = look.custom;
    changes.bg_image = look.bg_image || 0;
    changes.stickers = look.stickers.map((s) => ({ img: s.img, x: round2(s.x), y: round2(s.y), w: s.w, r: s.r }));
    // only send top friends once the list loaded, so a failed load can't wipe them
    if (tf.box.dataset.ready) changes.top_friends = top;
    try {
      pfCurrent = await saveProfile(changes);
      renderProfile(pfCurrent);
    } catch (ex) {
      err.textContent = ex.message;
      for (const b of saveButtons) b.disabled = false;
    }
  };
  body.append(form);
  syncAll();
  inputs.display_name.focus();
}

// ---------- wiring ----------

$("pf-close").onclick = closeProfile;
$("profile-overlay").addEventListener("click", (e) => {
  if (e.target === $("profile-overlay")) closeProfile();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("profile-overlay").hidden) closeProfile();
});
$("my-profile").onclick = () => openProfile(state.me);
$("view-profile").onclick = () => state.open && openProfile(state.open);
