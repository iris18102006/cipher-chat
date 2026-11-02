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
// Most of these are bundled in web/fonts (see fonts.css) so they look the same on every computer.
// The font is set on the card itself (not with a class) so it always beats the theme's own font.
const FONT_CHOICES = [
  ["verdana", "Classic", "Verdana, Tahoma, sans-serif"],
  ["nunito", "Nunito", '"Nunito", Verdana, sans-serif'],
  ["comic", "Comic Neue", '"Comic Neue", "Comic Sans MS", cursive'],
  ["lora", "Lora", '"Lora", Georgia, serif'],
  ["playfair", "Playfair", '"Playfair Display", Georgia, serif'],
  ["courier", "Courier Prime", '"Courier Prime", "Courier New", monospace'],
  ["typewriter", "Typewriter", '"Special Elite", "Courier New", monospace'],
  ["terminal", "Terminal", '"VT323", "Courier New", monospace'],
  ["pixel", "Pixel", '"Press Start 2P", monospace'],
  ["impact", "Poster", 'Anton, Impact, sans-serif'],
  ["script", "Handwriting", '"Dancing Script", "Brush Script MT", cursive'],
  ["gothic", "Gothic", '"Pirata One", "Old English Text MT", serif'],
];
// older choices: not in the picker any more, but profiles that picked them still show them
const LEGACY_FONTS = [
  ["arial", "Arial, Helvetica, sans-serif"],
  ["trebuchet", '"Trebuchet MS", Verdana, sans-serif'],
  ["georgia", 'Georgia, "Times New Roman", serif'],
  ["times", '"Times New Roman", Times, serif'],
  ["palatino", '"Palatino Linotype", Palatino, "Book Antiqua", serif'],
  ["lucida", '"Lucida Console", Monaco, monospace'],
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
  const legacy = LEGACY_FONTS.find((f) => f[0] === custom.font);
  if (font) card.style.setProperty("--p-font", font[2]);
  else if (legacy) card.style.setProperty("--p-font", legacy[1]);
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
