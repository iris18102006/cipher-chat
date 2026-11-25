// App themes: how the whole site looks. Like the profile and chat themes, you pick a
// look and it is saved on the server for you (web/app-themes.css holds the colours,
// the names match APP_THEMES in backend/main.py). "classic" is the default look, so
// it has no class and nobody needs a setting.

const APP_THEMES = [
  ["classic", "Classic"], ["neon", "Neon"], ["midnight", "Midnight"], ["terminal", "Terminal"],
  ["ocean", "Ocean"], ["forest", "Forest"], ["gothic", "Gothic"], ["kawaii", "Kawaii"],
  ["emo", "Emo"], ["sunset", "Sunset"],
];

// the colour on each swatch in the settings picker (same names as APP_THEMES)
const APP_THEME_SWATCH = {
  classic: "#17407f", neon: "#00e5ff", midnight: "#8a3fff", terminal: "#0c3", ocean: "#2a7bd9",
  forest: "#2e6b3f", gothic: "#4a0d12", kawaii: "#ff8ec7", emo: "#9d55c7", sunset: "#ff8a3d",
};

function currentAppTheme() {
  return document.documentElement.dataset.appTheme || "classic";
}

// put the theme's classes on <html>; "classic" means no theme, the default look
function applyAppTheme(name) {
  const root = document.documentElement;
  for (const c of [...root.classList]) if (c.startsWith("theme-")) root.classList.remove(c);
  if (name && name !== "classic") root.classList.add("theme-" + name);
  root.dataset.appTheme = name || "classic";
}

async function saveAppTheme(name) {
  await api("/api/app-theme", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_theme: name }),
  });
}
