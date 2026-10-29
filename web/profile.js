// Profile page: look at anyone's profile, edit your own.
// Loaded after app.js, which provides $, el, api, state, parseTs and lastSeenText.

const DEFAULT_AVATAR = "\u{1F642}";

function shownName(p) {
  return p.display_name || p.username;
}

function avatarFor(p) {
  return p.avatar || DEFAULT_AVATAR;
}

let pfCurrent = null; // the profile that is open right now

// ---------- open / close ----------

function closeProfile() {
  $("profile-overlay").hidden = true;
  pfCurrent = null;
}

async function openProfile(username) {
  $("profile-overlay").hidden = false;
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

// ---------- viewing ----------

function applyTheme(card, theme, accent) {
  card.className = "theme-" + (theme || "classic");
  if (accent) card.style.setProperty("--p-accent", accent);
  else card.style.removeProperty("--p-accent");
}

function section(title, text) {
  const box = el("div", "pf-section");
  box.append(el("h3", "", title));
  const body = el("div", "pf-content" + (text ? "" : " empty"), text || "nothing here yet");
  box.append(body);
  return box;
}

function stat(label, value) {
  const s = el("span");
  s.append(el("b", "", String(value)), " " + label);
  return s;
}

function renderProfile(p) {
  applyTheme($("profile-card"), p.theme, p.accent);
  $("pf-title").textContent = p.me ? "My profile" : shownName(p) + "'s profile";
  const body = $("pf-body");
  body.replaceChildren();

  const hero = el("div", "pf-hero");
  hero.append(el("div", "pf-avatar", avatarFor(p)));
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
  if (p.song) body.append(section("Now playing", "\u266A " + p.song));
  if (p.location) body.append(section("Location", p.location));

  const stats = el("div", "pf-stats");
  stats.append(stat("friends", p.friend_count));
  stats.append(stat("profile visitors", p.visitors));
  if (!p.me) stats.append(stat("mutual friends", p.mutual_friends));
  stats.append(el("span", "", "joined " + parseTs(p.joined).toLocaleDateString()));
  body.append(stats);
}

// ---------- editing ----------

// [field, label, max length, multiline, placeholder]
const TEXT_FIELDS = [
  ["display_name", "Display name", 30, false, "what your friends call you"],
  ["mood", "Mood", 40, false, "like: \u{1F634} sleepy"],
  ["headline", "Headline", 80, false, "a short line under your name"],
  ["about_me", "About me", 600, true, "tell people who you are"],
  ["interests", "Interests", 200, false, "music, games, anything"],
  ["location", "Location", 40, false, "where are you from?"],
  ["song", "Now playing", 80, false, "artist - song"],
];

function textRow(form, [field, label, max, multiline, hint], value) {
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
  form.append(row);
  return input;
}

const AVATARS = [
  "🦄", "🐱", "🐶", "🦊", "🐼", "🐸", "🐙", "🦋",
  "🌸", "🌙", "⭐", "🔥", "💀", "👾", "🤖", "👻",
  "🎧", "🎮", "🎸", "📚", "☕", "🍕", "🍓", "🌈",
  "⚡", "🖤", "💜", "🐞", "🦇", "🌵", "🍄", "🪐",
];
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

function choiceButton(box, label, selected, onPick, extraClass) {
  const b = el("button", "pf-choice" + (extraClass ? " " + extraClass : "") + (selected ? " on" : ""), label);
  b.type = "button";
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

function renderEditor(p) {
  const body = $("pf-body");
  body.replaceChildren();
  const form = el("form", "pf-form");
  form.autocomplete = "off";
  const inputs = {};
  // what's picked so far, applied to the card live so you see it before saving
  const look = { avatar: p.avatar, theme: p.theme, accent: p.accent };
  const preview = () => applyTheme($("profile-card"), look.theme, look.accent);

  for (const f of TEXT_FIELDS) inputs[f[0]] = textRow(form, f, p[f[0]]);

  const av = choiceRow("Avatar");
  choiceButton(av.box, "none", !look.avatar, () => (look.avatar = ""), "text");
  for (const emoji of AVATARS) {
    choiceButton(av.box, emoji, look.avatar === emoji, () => (look.avatar = emoji));
  }
  form.append(av.row);

  const th = choiceRow("Theme");
  for (const [id, label] of THEME_CHOICES) {
    choiceButton(th.box, label, look.theme === id, () => {
      look.theme = id;
      preview();
    }, "text");
  }
  form.append(th.row);

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
  form.append(ac.row);

  const err = el("p", "pf-error");
  const bar = el("div", "pf-actions");
  const save = el("button", "", "Save");
  save.type = "submit";
  const cancel = el("button", "", "Cancel");
  cancel.type = "button";
  cancel.onclick = () => renderProfile(pfCurrent);
  bar.append(save, cancel);
  form.append(err, bar);

  form.onsubmit = async (e) => {
    e.preventDefault();
    err.textContent = "";
    save.disabled = true;
    const changes = {};
    for (const [field] of TEXT_FIELDS) changes[field] = inputs[field].value;
    changes.avatar = look.avatar || "";
    changes.theme = look.theme;
    changes.accent = look.accent || "";
    try {
      pfCurrent = await saveProfile(changes);
      renderProfile(pfCurrent);
    } catch (ex) {
      err.textContent = ex.message;
      save.disabled = false;
    }
  };
  body.append(form);
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
