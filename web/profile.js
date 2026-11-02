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
