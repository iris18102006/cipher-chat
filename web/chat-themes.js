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
