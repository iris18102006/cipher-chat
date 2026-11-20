// The feed page: posts from you and your friends, newest first, on a page of its own inside
// the app (the Feed button in the top bar opens it, address #feed; one post is #post-12).
// Loaded after lists.js and dialogs.js. Uses $, el, api, state, toast, parseTs from app.js,
// sendJson from profile-media.js and avatarNode, shownName, openProfile from profile.js.
//
// Post text only ever goes in with textContent, never innerHTML, so nothing a friend writes
// can run as code. Pictures, videos and songs only come from /api/post-media/<number>.

const feed = {
  open: false,
  tab: "all", // all | close | mine
  posts: [], // newest first
  more: false, // are there older ones on the server?
  newCount: 0, // posts friends made while we weren't looking
  loading: false,
  admin: false,
  settings: null, // my post settings, for the audience a new post starts with
  single: null, // id of the one post being shown, or null for the list
};

const REPORT_REASONS = [
  ["nudity", "Nudity or sexual content"],
  ["violence", "Violence or gore"],
  ["harassment", "Threats, bullying or hate"],
  ["other", "Something else"],
];

// "just now", "5 min ago", "3 h ago", or the date for anything older than a day
function postAgo(ts) {
  const d = parseTs(ts);
  const secs = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (secs < 45) return "just now";
  if (secs < 3600) return Math.max(1, Math.round(secs / 60)) + " min ago";
  if (secs < 86400) return Math.round(secs / 3600) + " h ago";
  return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

function feedError(text) {
  const p = $("feed-error");
  p.textContent = text || "";
  p.hidden = !text;
}

// pictures, videos and songs only ever come from our own server
function safeMedia(url) {
  return typeof url === "string" && /^\/api\/post-media\/\d+$/.test(url) ? url : "";
}

// ---------- drawing a post ----------

function postSub(p) {
  const bits = ["@" + p.author.username, postAgo(p.created_at)];
  if (p.edited) bits.push("edited");
  return bits.join(" \u00b7 ");
}

function postHead(p, opts) {
  const head = el("div", "feed-head");
  const avatar = avatarNode(p.author, "small");
  avatar.onclick = () => openProfile(p.author.username);
  const who = el("div", "feed-who");
  const name = el("b", "", shownName(p.author));
  name.onclick = () => openProfile(p.author.username);
  const sub = el("small", "feed-sub", postSub(p));
  if (p.audience && p.audience !== "friends" && !(opts && opts.quiet)) {
    sub.append(" \u00b7 ", el("span", "feed-audience a-" + p.audience, AUDIENCE_LABELS[p.audience]));
  }
  who.append(name, sub);
  head.append(avatar, who);
  return head;
}

