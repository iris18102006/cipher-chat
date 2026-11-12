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
  card.append(postActions(p, card));
  return card;
}

// ---------- like, share, delete ----------

function likeLabel(p) {
  return (p.liked ? "\u2665 " : "\u2661 ") + p.likes;
}

function postActions(p, card) {
  const bar = el("div", "feed-actions");

  const like = el("button", p.liked ? "on" : "", likeLabel(p));
  like.type = "button";
  like.setAttribute("aria-pressed", String(p.liked));
  like.setAttribute("aria-label", p.liked ? "unlike" : "like");
  like.onclick = async () => {
    like.disabled = true;
    try {
      const r = await sendJson("/api/posts/" + p.id + "/like", p.liked ? "DELETE" : "POST");
      p.likes = r.likes;
      p.liked = r.liked;
      like.textContent = likeLabel(p);
      like.classList.toggle("on", p.liked);
      like.setAttribute("aria-pressed", String(p.liked));
      like.setAttribute("aria-label", p.liked ? "unlike" : "like");
    } catch (ex) {
      feedError(ex.message);
    } finally {
      like.disabled = false;
    }
  };
  bar.append(like);

  // a share of a post that's gone, or that you can't read, has nothing to share onward
  const original = p.is_share ? p.original : null;
  const sharable = !original || !(original.gone || original.hidden);
  if (sharable) {
    const target = original || p;
    const share = el("button", "", "\u21c4 Share" + (target.shares ? " " + target.shares : ""));
    share.type = "button";
    share.onclick = () => toggleShareForm(card, target, share);
    bar.append(share);
  }

  if (p.mine) {
    const del = el("button", "danger", "Delete");
    del.type = "button";
    del.onclick = () => deletePost(p, del);
    bar.append(del);
  }
  return bar;
}

async function deletePost(p, button) {
  if (!confirm("Delete this post? Shares of it will say the original was deleted.")) return;
  button.disabled = true;
  try {
    await sendJson("/api/posts/" + p.id, "DELETE");
    feed.posts = feed.posts.filter((x) => x.id !== p.id);
    renderFeed();
  } catch (ex) {
    feedError(ex.message);
    button.disabled = false;
  }
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

// ---------- opening and closing ----------

function setNewCount(n) {
  feed.newCount = n;
  const badge = $("feed-count-new");
  badge.textContent = String(n);
  badge.hidden = n === 0;
  const pill = $("feed-new");
  pill.hidden = n === 0 || !feed.open;
  pill.textContent = n === 1 ? "1 new post, show it" : n + " new posts, show them";
}

async function openFeed() {
  feed.returnFocus = document.activeElement;
  feed.open = true;
  $("feed-overlay").hidden = false;
  setNewCount(0);
  $("feed-text").focus();
  await loadFeed(false);
}

function closeFeed() {
  feed.open = false;
  $("feed-overlay").hidden = true;
  if (feed.returnFocus && document.contains(feed.returnFocus)) feed.returnFocus.focus();
  feed.returnFocus = null;
}

$("feed-btn").onclick = openFeed;
$("feed-close").onclick = closeFeed;
$("feed-refresh").onclick = () => {
  setNewCount(0);
  loadFeed(false);
};
$("feed-new").onclick = () => {
  setNewCount(0);
  loadFeed(false);
  $("feed-window").scrollIntoView({ block: "start" });
};
$("feed-more").onclick = () => loadFeed(true);
$("feed-overlay").addEventListener("click", (e) => {
  if (e.target === $("feed-overlay")) closeFeed();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !feed.open) return;
  // a profile page opened from the feed sits on top and closes first
  const profile = document.getElementById("profile-overlay");
  if (profile && !profile.hidden) return;
  closeFeed();
});

// ---------- writing a post ----------

function paintCounter() {
  const left = POST_MAX - $("feed-text").value.length;
  const c = $("feed-chars");
  c.textContent = String(left);
  c.classList.toggle("low", left <= 50);
  $("feed-post").disabled = $("feed-text").value.trim() === "";
}

$("feed-text").addEventListener("input", paintCounter);
$("feed-text").addEventListener("keydown", (e) => {
  // Ctrl+Enter / Cmd+Enter posts, plain Enter makes a new line
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    $("feed-compose").requestSubmit();
  }
});

$("feed-compose").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("feed-text").value.trim();
  if (!text) return;
  feedError("");
  $("feed-post").disabled = true;
  try {
    const p = await sendJson("/api/posts", "POST", { body: text });
    $("feed-text").value = "";
    feed.posts.unshift(p);
    renderFeed();
    $("feed-list").firstChild.classList.add("is-new");
  } catch (ex) {
    feedError(ex.message); // sendJson only throws messages that are safe to show
  } finally {
    paintCounter();
  }
};

paintCounter();

// ---------- sharing ----------

// The little form under a post: an optional note, then Share. Press the button again to close it.
function toggleShareForm(card, target, button) {
  const old = card.querySelector(".feed-share-form");
  if (old) {
    old.remove();
    button.focus();
    return;
  }
  const form = el("form", "feed-share-form");
  const note = el("textarea");
  note.maxLength = NOTE_MAX;
  note.rows = 2;
  note.placeholder = "add a note (optional)";
  note.setAttribute("aria-label", "note to go with the shared post");
  const err = el("span", "err");
  const go = el("button", "", "Share");
  go.type = "submit";
  const cancel = el("button", "", "Cancel");
  cancel.type = "button";
  cancel.onclick = () => {
    form.remove();
    button.focus();
  };
  const row = el("div", "row");
  row.append(go, cancel, err);
  form.append(note, row);
  form.onsubmit = async (e) => {
    e.preventDefault();
    go.disabled = true;
    err.textContent = "";
    try {
      const made = await sendJson("/api/posts/" + target.id + "/share", "POST", { body: note.value.trim() });
      // every copy of the original on screen now has one more share
      for (const p of feed.posts) {
        if (p.id === target.id) p.shares = made.original.shares;
        if (p.is_share && p.original && p.original.id === target.id) p.original.shares = made.original.shares;
      }
      feed.posts.unshift(made);
      renderFeed();
      $("feed-list").firstChild.classList.add("is-new");
    } catch (ex) {
      err.textContent = ex.message;
      go.disabled = false;
    }
  };
  card.append(form);
  note.focus();
}
