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

// ---------- viewing ----------

const CUSTOM_COLOR_VARS = {
  page: "--p-page", card: "--p-card", text: "--p-text", head_a: "--p-head-a",
  head_b: "--p-head-b", head_text: "--p-head-text", border: "--p-border",
};
const CUSTOM_CLASSES = [
  "font-verdana", "font-comic", "font-georgia", "font-courier", "font-trebuchet", "font-times", "font-impact",
  "pattern-dots", "pattern-stripes", "pattern-checks", "pattern-grid", "pattern-diagonal", "pattern-stars", "pattern-hearts",
  "name-glow", "name-shadow", "name-rainbow", "pf-marquee",
];

function applyTheme(card, theme, accent, custom = {}) {
  card.className = "theme-" + (theme || "classic");
  for (const cls of CUSTOM_CLASSES) card.classList.remove(cls);
  for (const variable of Object.values(CUSTOM_COLOR_VARS)) card.style.removeProperty(variable);
  card.style.removeProperty("--p-border-width");
  card.style.removeProperty("--p-radius");
  card.style.removeProperty("--p-border-style");

  if (accent) card.style.setProperty("--p-accent", accent);
  else card.style.removeProperty("--p-accent");
  for (const [key, variable] of Object.entries(CUSTOM_COLOR_VARS)) {
    if (custom[key]) card.style.setProperty(variable, custom[key]);
  }
  if (custom.font) card.classList.add("font-" + custom.font);
  if (custom.pattern && custom.pattern !== "none") card.classList.add("pattern-" + custom.pattern);
  if (custom.name_effect && custom.name_effect !== "none") card.classList.add("name-" + custom.name_effect);
  if (custom.marquee) card.classList.add("pf-marquee");
  if (Number.isInteger(custom.border_width)) card.style.setProperty("--p-border-width", custom.border_width + "px");
  if (Number.isInteger(custom.radius)) card.style.setProperty("--p-radius", custom.radius + "px");
  if (custom.border_style) card.style.setProperty("--p-border-style", custom.border_style);
}

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
    item.append(el("div", "pf-avatar small", avatarFor(f)), el("span", "", shownName(f)));
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
      const who = el("button", "pf-wall-who", avatarFor(c) + " " + shownName(c));
      who.type = "button";
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
  applyTheme($("profile-card"), p.theme, p.accent, p.custom);
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
  if (p.top_friends.length || p.me) body.append(topFriendsSection(p));
  if (p.location) body.append(section("Location", p.location));
  body.append(wallSection(p));

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
  const look = { avatar: p.avatar, theme: p.theme, accent: p.accent, custom: { ...(p.custom || {}) } };
  const preview = () => applyTheme($("profile-card"), look.theme, look.accent, look.custom);

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

  const customTitle = el("div", "pf-custom-title", "Make it yours");
  customTitle.append(el("span", "", " — safe MySpace-style controls, no raw CSS needed"));
  form.append(customTitle);

  const colorFields = [
    ["page", "Page"], ["card", "Boxes"], ["text", "Text"], ["head_a", "Header 1"],
    ["head_b", "Header 2"], ["head_text", "Header text"], ["border", "Borders"],
  ];
  const colors = el("div", "pf-style-grid");
  for (const [key, label] of colorFields) {
    const wrap = el("label", "pf-style-color");
    wrap.append(el("span", "", label));
    const input = el("input");
    input.type = "color";
    input.value = look.custom[key] || ({ page: "#eef3fb", card: "#ffffff", text: "#111111", head_a: "#2a5da8", head_b: "#17407f", head_text: "#ffffff", border: "#7f9db9" }[key]);
    input.oninput = () => { look.custom[key] = input.value; preview(); };
    wrap.append(input);
    colors.append(wrap);
  }
  form.append(colors);

  function selectStyle(label, key, choices, fallback) {
    const row = el("label", "pf-style-row");
    row.append(el("span", "", label));
    const sel = el("select");
    for (const [value, text] of choices) {
      const opt = el("option", "", text);
      opt.value = value;
      if ((look.custom[key] || fallback) === value) opt.selected = true;
      sel.append(opt);
    }
    sel.onchange = () => { look.custom[key] = sel.value; preview(); };
    row.append(sel);
    form.append(row);
  }

  selectStyle("Font", "font", [["verdana","Verdana"],["comic","Comic Sans"],["georgia","Georgia"],["courier","Courier"],["trebuchet","Trebuchet"],["times","Times"],["impact","Impact"]], "verdana");
  selectStyle("Background pattern", "pattern", [["none","None"],["dots","Dots"],["stripes","Stripes"],["checks","Checks"],["grid","Grid"],["diagonal","Diagonal"],["stars","Stars"],["hearts","Hearts"]], "none");
  selectStyle("Border style", "border_style", [["solid","Solid"],["dashed","Dashed"],["dotted","Dotted"],["double","Double"],["ridge","Ridge"],["groove","Groove"]], "solid");
  selectStyle("Name effect", "name_effect", [["none","None"],["glow","Glow"],["shadow","Shadow"],["rainbow","Rainbow"]], "none");

  function rangeStyle(label, key, min, max, fallback) {
    const row = el("label", "pf-style-row");
    const value = el("b", "", String(look.custom[key] ?? fallback));
    const left = el("span", "");
    left.append(label + " ", value);
    const input = el("input");
    input.type = "range"; input.min = String(min); input.max = String(max);
    input.value = String(look.custom[key] ?? fallback);
    input.oninput = () => { look.custom[key] = Number(input.value); value.textContent = input.value; preview(); };
    row.append(left, input);
    form.append(row);
  }
  rangeStyle("Border width", "border_width", 0, 6, 2);
  rangeStyle("Corner roundness", "radius", 0, 24, 0);

  const marquee = el("label", "pf-style-row check");
  const marqueeInput = el("input");
  marqueeInput.type = "checkbox"; marqueeInput.checked = !!look.custom.marquee;
  marqueeInput.onchange = () => { look.custom.marquee = marqueeInput.checked; preview(); };
  marquee.append(el("span", "", "Scrolling display name"), marqueeInput);
  form.append(marquee);

  const reset = el("button", "pf-reset-style", "Reset custom styling");
  reset.type = "button";
  reset.onclick = () => { look.custom = {}; renderEditor({ ...p, avatar: look.avatar, theme: look.theme, accent: look.accent, custom: {} }); };
  form.append(reset);

  // top friends: tap friends in the order you want them, up to 8
  const top = (p.top_friends || []).map((f) => f.username);
  const tf = choiceRow("Top friends", "max 8");
  tf.box.textContent = "loading...";
  form.append(tf.row);
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
          const b = el("button", "pf-choice text" + (at >= 0 ? " on" : ""));
          b.type = "button";
          b.textContent = (at >= 0 ? at + 1 + ". " : "") + avatarFor(f) + " " + shownName(f);
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
    changes.custom = look.custom;
    // only send top friends once the list loaded, so a failed load can't wipe them
    if (tf.box.dataset.ready) changes.top_friends = top;
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
