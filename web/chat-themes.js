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
