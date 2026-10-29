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

  // buttons (edit, add friend, block...) get filled in by their own features
  body.append(el("div", "pf-actions"));

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
