// Chat themes: how one conversation looks for you. Only you see it, it's saved
// on the server per person per chat. The names must match CHAT_THEMES and
// CHAT_PATTERNS in backend/chat_themes.py, and the .ct-* classes in chat-themes.css.

const CHAT_THEMES = [
  ["classic", "Classic"], ["emo", "Emo"], ["kawaii", "Kawaii"], ["neon", "Neon"], ["forest", "Forest"],
  ["sunset", "Sunset"], ["gothic", "Gothic"], ["terminal", "Terminal"], ["ocean", "Ocean"], ["midnight", "Midnight"],
];
const CHAT_PATTERNS = [["none", "None"], ["dots", "Dots"], ["grid", "Grid"], ["hearts", "Hearts"], ["stars", "Stars"]];
const CHAT_ACCENTS = ["#ff9933", "#ff2e93", "#b3122a", "#39ff14", "#00b3a4", "#2a5da8", "#7a2cff", "#ffd633"];
const CHAT_DEFAULT = { theme: "classic", accent: "", pattern: "none" };

const chatThemes = { dm: {}, group: {} };

function currentChatLook() {
  const mine = state.openGroup != null ? chatThemes.group[String(state.openGroup)] : chatThemes.dm[state.open];
  return mine || CHAT_DEFAULT;
}

function chatThemeUrl() {
  return state.openGroup != null
    ? "/api/chat-themes/group/" + state.openGroup
    : "/api/chat-themes/dm/" + encodeURIComponent(state.open);
}

// put the look on the chat pane (only names from our own lists ever become classes)
function applyChatTheme() {
  const pane = $("chat-pane");
  const look = currentChatLook();
  for (const c of [...pane.classList]) if (c.startsWith("ct-") || c.startsWith("cp-")) pane.classList.remove(c);
  if (CHAT_THEMES.some(([n]) => n === look.theme)) pane.classList.add("ct-" + look.theme);
  if (CHAT_PATTERNS.some(([n]) => n === look.pattern) && look.pattern !== "none") pane.classList.add("cp-" + look.pattern);
  if (/^#[0-9a-f]{6}$/i.test(look.accent)) {
    pane.classList.add("ct-accent");
    pane.style.setProperty("--c-accent", look.accent);
  } else {
    pane.style.removeProperty("--c-accent");
  }
}

async function loadChatThemes() {
  const all = await api("/api/chat-themes");
  chatThemes.dm = all.dm || {};
  chatThemes.group = all.group || {};
  applyChatTheme();
}

async function saveChatLook(look) {
  const open = state.openGroup != null ? "g" + state.openGroup : "d" + state.open;
  const store = state.openGroup != null ? chatThemes.group : chatThemes.dm;
  const key = state.openGroup != null ? String(state.openGroup) : state.open;
  const before = store[key];
  // show it straight away, then ask the server; put it back if that fails
  if (look.theme === "classic" && !look.accent && look.pattern === "none") delete store[key];
  else store[key] = look;
  applyChatTheme();
  renderChatThemePicker();
  try {
    await api(chatThemeUrl(), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(look),
    });
    $("ct-status").textContent = "saved";
    $("ct-status").className = "";
  } catch {
    const still = (state.openGroup != null ? "g" + state.openGroup : "d" + state.open) === open;
    if (before) store[key] = before;
    else delete store[key];
    if (still) {
      applyChatTheme();
      renderChatThemePicker();
    }
    $("ct-status").textContent = "couldn't save that, try again";
    $("ct-status").className = "bad";
  }
}

function chatThemeButton(cls, label, pressed, onClick) {
  const b = el("button", cls, label);
  b.type = "button";
  b.setAttribute("aria-pressed", pressed ? "true" : "false");
  b.onclick = onClick;
  return b;
}

function renderChatThemePicker() {
  const body = $("ct-body");
  const look = currentChatLook();
  const status = $("ct-status") ? { t: $("ct-status").textContent, c: $("ct-status").className } : { t: "", c: "" };
  body.replaceChildren();

  const who = state.openGroup != null ? state.groups.get(state.openGroup)?.name : state.contacts.get(state.open) && shownName(state.contacts.get(state.open));
  body.append(el("p", "ct-for", "How this chat looks for you" + (who ? " (" + who + ")" : "") + ". Nobody else sees it."));

  const themes = el("fieldset");
  themes.append(el("legend", "", "Theme"));
  const grid = el("div", "ct-grid");
  for (const [name, label] of CHAT_THEMES) {
    const b = chatThemeButton("ct-swatch ct-" + name, "", look.theme === name, () => saveChatLook({ ...look, theme: name }));
    const head = el("span", "sw-head");
    const log = el("span", "sw-log");
    log.append(el("span", "sw-b them"), el("span", "sw-b me"));
    b.append(head, log, el("span", "sw-name", label));
    grid.append(b);
  }
  themes.append(grid);
  body.append(themes);

  const pats = el("fieldset");
  pats.append(el("legend", "", "Background"));
  const chips = el("div", "ct-chips");
  for (const [name, label] of CHAT_PATTERNS) {
    chips.append(chatThemeButton("ct-chip", label, look.pattern === name, () => saveChatLook({ ...look, pattern: name })));
  }
  pats.append(chips);
  body.append(pats);

  const acc = el("fieldset");
  acc.append(el("legend", "", "Accent colour"));
  const dots = el("div", "ct-chips");
  dots.append(chatThemeButton("ct-chip", "Theme's own", !look.accent, () => saveChatLook({ ...look, accent: "" })));
  for (const c of CHAT_ACCENTS) {
    const d = chatThemeButton("ct-dot", "", look.accent === c, () => saveChatLook({ ...look, accent: c }));
    d.style.background = c;
    d.title = c;
    d.setAttribute("aria-label", "accent " + c);
    dots.append(d);
  }
  acc.append(dots);
  const row = el("div", "ct-accent-row");
  const picker = el("input");
  picker.type = "color";
  picker.value = look.accent || "#ff9933";
  picker.setAttribute("aria-label", "pick your own accent colour");
  picker.onchange = () => saveChatLook({ ...look, accent: picker.value.toLowerCase() });
  row.append(picker, el("span", "", "or pick your own"));
  acc.append(row);
  body.append(acc);

  const reset = el("button", "", "Back to the normal look");
  reset.type = "button";
  reset.onclick = () => saveChatLook({ ...CHAT_DEFAULT });
  body.append(reset);
  const st = el("p", "", status.t);
  st.id = "ct-status";
  st.className = status.c;
  body.append(st);
}

function openChatThemePicker() {
  if (state.open == null && state.openGroup == null) return;
  renderChatThemePicker();
  $("ct-overlay").hidden = false;
}

function closeChatThemePicker() {
  $("ct-overlay").hidden = true;
}

$("chat-theme").onclick = openChatThemePicker;
$("ct-close").onclick = closeChatThemePicker;
$("ct-overlay").addEventListener("mousedown", (e) => {
  if (e.target === $("ct-overlay")) closeChatThemePicker();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("ct-overlay").hidden) closeChatThemePicker();
});
