// The feed window: posts from you and your friends, newest first.
// Loaded after lists.js. Uses $, el, api, state, toast, parseTs from app.js, sendJson from
// profile-media.js and avatarNode, shownName, openProfile from profile.js.
//
// Post text only ever goes in with textContent, never innerHTML, so nothing a friend writes
// can run as code.

const POST_MAX = 500;
const NOTE_MAX = 300;

const feed = {
  open: false,
  posts: [], // newest first
  more: false, // are there older ones on the server?
  newCount: 0, // posts friends made while we weren't looking
  loading: false,
  returnFocus: null,
};

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

// ---------- drawing a post ----------

function postHead(p) {
  const head = el("div", "feed-head");
  const avatar = avatarNode(p.author, "small");
  avatar.onclick = () => openProfile(p.author.username);
  const who = el("div", "feed-who");
  const name = el("b", "", shownName(p.author));
  name.onclick = () => openProfile(p.author.username);
  const sub = el("small", "", "@" + p.author.username + " \u00b7 " + postAgo(p.created_at));
  who.append(name, sub);
  head.append(avatar, who);
  return head;
}

// what a shared post says about the original
function originalBox(o) {
  if (o.gone) return el("div", "feed-original is-note", "The original post was deleted.");
  if (o.hidden) return el("div", "feed-original is-note", "A post from someone you're not friends with.");
  const box = el("div", "feed-original");
  box.append(postHead(o), el("p", "feed-body", o.body));
  return box;
}

function renderPost(p) {
  const card = el("article", "feed-post" + (p.mine ? " mine" : ""));
  card.dataset.id = String(p.id);
  const head = postHead(p);
  if (p.is_share) head.querySelector(".feed-who b").after(el("span", "feed-shared-tag", "shared a post"));
  card.append(head);
  if (p.body) card.append(el("p", "feed-body", p.body));
  if (p.is_share && p.original) card.append(originalBox(p.original));
  return card;
}

function renderFeed() {
  const list = $("feed-list");
  list.replaceChildren();
  if (!feed.posts.length) {
    list.append(el("p", "feed-empty", "Nothing here yet. Post something, or add some friends."));
  } else {
    for (const p of feed.posts) list.append(renderPost(p));
  }
  $("feed-more").hidden = !feed.more;
}

// ---------- loading ----------

async function loadFeed(older) {
  if (feed.loading) return;
  feed.loading = true;
  feedError("");
  try {
    const q = older && feed.posts.length ? "?before=" + feed.posts[feed.posts.length - 1].id : "";
    const data = await api("/api/feed" + q);
    feed.posts = older ? feed.posts.concat(data.posts) : data.posts;
    feed.more = data.more;
    renderFeed();
  } catch (ex) {
    feedError(ex.server ? ex.message : "couldn't load the feed, try again");
  } finally {
    feed.loading = false;
  }
}
