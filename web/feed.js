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

// the pictures, video and song on a post
function mediaNode(list) {
  const box = el("div", "feed-media");
  const pics = list.filter((m) => m.kind === "image" && safeMedia(m.url));
  if (pics.length) {
    const grid = el("div", "feed-pics n" + pics.length);
    for (const m of pics) {
      const img = el("img");
      img.src = m.url;
      img.alt = "picture in a post";
      img.loading = "lazy";
      img.draggable = false;
      img.onclick = () => {
        const big = el("img", "feed-big");
        big.src = m.url;
        big.alt = "picture in a post";
        openDialog("Picture", big, { wide: true });
      };
      grid.append(img);
    }
    box.append(grid);
  }
  for (const m of list) {
    if (!safeMedia(m.url)) continue;
    if (m.kind === "video") {
      const v = el("video", "feed-video");
      v.controls = true;
      v.preload = "metadata";
      v.playsInline = true;
      v.src = m.url;
      box.append(v);
    } else if (m.kind === "audio") {
      const wrap = el("div", "feed-song");
      wrap.append(el("span", "feed-song-icon", "\u{1f3b5}"));
      const a = el("audio");
      a.controls = true;
      a.preload = "none";
      a.src = m.url;
      wrap.append(a);
      box.append(wrap);
    }
  }
  return box.childNodes.length ? box : null;
}

function postBody(p) {
  const frag = [];
  if (p.body) frag.push(el("p", "feed-body", p.body));
  const m = mediaNode(p.media || []);
  if (m) frag.push(m);
  return frag;
}

// what a repost says about the original
function originalBox(o) {
  if (o.gone) return el("div", "feed-original is-note", "The original post was deleted.");
  if (o.hidden) return el("div", "feed-original is-note", "A post from someone you're not friends with, or that isn't shared with you.");
  const box = el("div", "feed-original");
  box.append(postHead(o, { quiet: true }), ...postBody(o));
  return box;
}

function renderPost(p) {
  const card = el("article", "feed-post" + (p.mine ? " mine" : "") + (p.hidden ? " is-hidden" : ""));
  card.dataset.id = String(p.id);
  const head = postHead(p);
  if (p.is_repost) head.querySelector(".feed-who b").after(el("span", "feed-shared-tag", "reposted"));
  card.append(head);
  if (p.hidden) {
    card.append(el("p", "feed-hidden-note", "Hidden: people reported this post, so only you can see it until it has been looked at."));
  }
  card.append(...postBody(p));
  if (p.is_repost && p.original) card.append(originalBox(p.original));
  const engage = el("div", "feed-engage");
  card.append(engage);
  paintEngage(card, p);
  return card;
}

// ---------- likes, reposts, sharing, edit, delete, report ----------

// "Liked by anna, ben and 3 others", the names open the whole list
function likeSummary(p) {
  if (p.likes_hidden && !p.mine) return null;
  if (!p.likes) return null;
  if (!p.likes_names || !p.likers.length) return el("div", "feed-likes", p.likes === 1 ? "1 like" : p.likes + " likes");
  const names = p.likers.map(shownName);
  const others = p.likes - names.length;
  let text = "Liked by " + names.join(", ");
  if (others > 0) text += " and " + others + (others === 1 ? " other" : " others");
  const btn = plainButton(text, () => showLikes(p), "feed-likes link");
  btn.title = "see everyone who liked this";
  return btn;
}

function likeLabel(p) {
  return (p.liked ? "\u2665 Liked" : "\u2661 Like") + (p.likes && !p.likes_hidden ? " " + p.likes : "");
}

function paintEngage(card, p) {
  const engage = card.querySelector(".feed-engage");
  // a repost's original is what gets reposted, shared and reported
  const target = p.is_repost && p.original && !p.original.gone && !p.original.hidden ? p.original : p.is_repost ? null : p;
  const bar = el("div", "feed-actions");

  const like = plainButton(likeLabel(p), null, p.liked ? "on" : "");
  like.setAttribute("aria-pressed", String(p.liked));
  like.onclick = async () => {
    like.disabled = true;
    try {
      Object.assign(p, await sendJson("/api/posts/" + p.id + "/like", p.liked ? "DELETE" : "POST"));
      paintEngage(card, p);
    } catch (ex) {
      feedError(ex.message);
      like.disabled = false;
    }
  };
  bar.append(like);

  if (target && target.can_repost) {
    const n = target.reposts ? " " + target.reposts : "";
    bar.append(plainButton("\u21bb Repost" + n, () => repostDialog(target)));
  }
  if (target && target.can_send) bar.append(plainButton("\u2708 Share", () => shareDialog(target)));

  if (p.mine) {
    bar.append(plainButton("Edit", () => editDialog(p, card)));
    bar.append(plainButton("Delete", () => deletePost(p), "danger"));
  } else if (target && !target.mine) {
    bar.append(plainButton(target.reported ? "Reported" : "Report", () => reportDialog(target, card), "quiet"));
    if (target.reported) bar.lastChild.disabled = true;
  }
  engage.replaceChildren(...[likeSummary(p), bar].filter(Boolean));
}

async function showLikes(p) {
  const list = el("div", "likes-list", "loading...");
  openDialog("Liked by", list);
  try {
    const data = await api("/api/posts/" + p.id + "/likes");
    if (!data.likers.length) return list.replaceChildren(el("p", "list-empty", "Nobody yet."));
    list.replaceChildren(
      ...data.likers.map((u) => {
        const row = plainButton("", () => {
          openProfile(u.username);
        }, "likes-row");
        const who = el("span", "who");
        who.append(el("b", "", shownName(u)), el("small", "", "@" + u.username));
        row.append(avatarNode(u, "small"), who);
        return row;
      })
    );
  } catch (ex) {
    list.replaceChildren(el("p", "feed-error-text", whyFailed(ex, "couldn't load the list")));
  }
}

function afterChange(p, fresh) {
  // keep every copy of this post on screen in step (the post itself and reposts that show it)
  for (const q of feed.posts) {
    if (q.id === p.id) Object.assign(q, fresh);
    if (q.is_repost && q.original && q.original.id === p.id) Object.assign(q.original, fresh);
  }
  renderFeed();
}

function editDialog(p, card) {
  const form = makeComposer({
    post: p,
    onDone: (fresh) => {
      dlg.close();
      // an edit keeps a repost's original, so only the parts that can change are copied over
      Object.assign(p, fresh, p.is_repost ? { original: p.original } : {});
      renderFeed();
    },
    onCancel: () => dlg.close(),
  });
  const dlg = openDialog(p.is_repost ? "Edit your note" : "Edit post", form, { wide: true });
}

function repostDialog(target) {
  const form = el("form", "feed-repost-form");
  const note = el("textarea");
  note.maxLength = NOTE_MAX;
  note.rows = 3;
  note.placeholder = "add a note (optional)";
  note.setAttribute("aria-label", "note to go with the repost");
  const who = el("select");
  who.setAttribute("aria-label", "who can see your repost");
  for (const [value, name] of AUDIENCE_OPTIONS) {
    const o = el("option", "", name);
    o.value = value;
    who.append(o);
  }
  who.value = (feed.settings && feed.settings.post_audience) || "friends";
  const err = el("p", "fc-error");
  err.hidden = true;
  const go = el("button", "fc-submit", "Repost");
  go.type = "submit";
  const row = el("div", "fc-row");
  row.append(who, go);
  form.append(el("p", "pf-hint", "Reposting puts this post on your page too. Only friends of " + shownName(target.author) + " can see what it says."), note, err, row);
  form.onsubmit = async (e) => {
    e.preventDefault();
    go.disabled = true;
    err.hidden = true;
    try {
      const made = await sendJson("/api/posts/" + target.id + "/repost", "POST", { body: note.value.trim(), audience: who.value });
      // every copy of the original on screen has one more repost
      for (const q of feed.posts) {
        if (q.id === target.id) q.reposts = made.original.reposts;
        if (q.is_repost && q.original && q.original.id === target.id) q.original.reposts = made.original.reposts;
      }
      dlg.close();
      if (feed.single == null && (feed.tab === "all" || feed.tab === "mine")) feed.posts.unshift(made);
      renderFeed();
      toast("Reposted");
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      go.disabled = false;
    }
  };
  const dlg = openDialog("Repost", form);
}

function reportDialog(target, card) {
  const form = el("form", "feed-report-form");
  form.append(el("p", "pf-hint", "Why are you reporting this? When enough people report a post it is hidden until somebody looks at it. The author isn't told who reported."));
  let chosen = "";
  const go = el("button", "fc-submit", "Report");
  go.type = "submit";
  go.disabled = true;
  for (const [value, name] of REPORT_REASONS) {
    const row = el("label", "opt");
    const input = el("input");
    input.type = "radio";
    input.name = "report-reason";
    input.value = value;
    input.onchange = () => {
      chosen = value;
      go.disabled = false;
    };
    row.append(input, el("span", "", name));
    form.append(row);
  }
  const err = el("p", "fc-error");
  err.hidden = true;
  form.append(err, go);
  form.onsubmit = async (e) => {
    e.preventDefault();
    go.disabled = true;
    try {
      await sendJson("/api/posts/" + target.id + "/report", "POST", { reason: chosen });
      target.reported = true;
      dlg.close();
      renderFeed();
      toast("Thanks, it's been reported");
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      go.disabled = false;
    }
  };
  const dlg = openDialog("Report this post", form);
}

async function deletePost(p) {
  if (!confirm("Delete this post? Reposts of it will say the original was deleted.")) return;
  try {
    await sendJson("/api/posts/" + p.id, "DELETE");
    feed.posts = feed.posts.filter((x) => x.id !== p.id);
    if (feed.single === p.id) return closeSingle();
    renderFeed();
  } catch (ex) {
    feedError(ex.message);
  }
}

function renderFeed() {
  const list = $("feed-list");
  list.replaceChildren();
  if (!feed.posts.length) {
    const text = feed.tab === "close" ? "No close friends posts yet. Pick your close friends in Settings." : feed.tab === "mine" ? "You haven't posted anything yet." : "Nothing here yet. Post something, or add some friends.";
    list.append(el("p", "feed-empty", text));
  } else {
    for (const p of feed.posts) list.append(renderPost(p));
  }
  $("feed-more").hidden = !feed.more || feed.single != null;
}

// ---------- loading ----------

async function loadFeed(older) {
  if (feed.loading) return;
  feed.loading = true;
  feedError("");
  const tab = feed.tab;
  try {
    const q = new URLSearchParams({ tab });
    if (older && feed.posts.length) q.set("before", String(feed.posts[feed.posts.length - 1].id));
    const data = await api("/api/feed?" + q);
    if (tab !== feed.tab || feed.single != null) return; // they moved on while it loaded
    feed.posts = older ? feed.posts.concat(data.posts) : data.posts;
    feed.more = data.more;
    renderFeed();
  } catch (ex) {
    feedError(ex.server ? ex.message : "couldn't load the feed, try again");
  } finally {
    feed.loading = false;
  }
}

async function loadSingle(id) {
  feedError("");
  $("feed-list").replaceChildren(el("p", "feed-empty", "loading..."));
  try {
    const p = await api("/api/posts/" + id);
    if (feed.single !== id) return;
    feed.posts = [p];
    renderFeed();
  } catch (ex) {
    if (feed.single !== id) return;
    feed.posts = [];
    $("feed-list").replaceChildren(el("p", "feed-empty", ex.status === 404 ? "This post isn't available to you. It may have been deleted, or it isn't shared with you." : "couldn't load that post, try again"));
  }
}

async function loadFeedExtras() {
  try {
    const [meta, settings] = await Promise.all([api("/api/feed/meta"), api("/api/settings")]);
    feed.admin = meta.admin;
    feed.settings = settings;
    $("feed-admin").hidden = !meta.admin;
    if (meta.admin) loadReports();
  } catch {}
}

// ---------- the page: opening, closing, tabs ----------

function setNewCount(n) {
  feed.newCount = n;
  const badge = $("feed-count-new");
  badge.textContent = String(n);
  badge.hidden = n === 0;
  const pill = $("feed-new");
  pill.hidden = n === 0 || !feed.open || feed.single != null;
  pill.textContent = n === 1 ? "1 new post, show it" : n + " new posts, show them";
}

function paintTabs() {
  for (const b of document.querySelectorAll("#feed-tabs button")) {
    const on = b.dataset.tab === feed.tab && feed.single == null;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  }
  $("feed-compose-box").hidden = feed.single != null;
  $("feed-tabs").hidden = feed.single != null;
  $("feed-back-feed").hidden = feed.single == null;
  $("feed-title").textContent = feed.single != null ? "Post" : "Feed";
}

function showPage() {
  if (!feed.open) {
    feed.open = true;
    document.body.classList.add("on-feed");
    $("feed-page").hidden = false;
    $("feed-btn").classList.add("on");
    loadFeedExtras();
  }
}

function showFeed() {
  showPage();
  feed.single = null;
  setNewCount(0);
  paintTabs();
  mountCompose();
  loadFeed(false);
}

function showPost(id) {
  showPage();
  feed.single = id;
  setNewCount(0);
  paintTabs();
  loadSingle(id);
}

function hideFeed() {
  if (!feed.open) return;
  feed.open = false;
  feed.single = null;
  document.body.classList.remove("on-feed");
  $("feed-page").hidden = true;
  $("feed-btn").classList.remove("on");
}

function openFeed() {
  if (location.hash === "#feed") showFeed();
  else location.hash = "#feed";
}

function openPostPage(id) {
  location.hash = "#post-" + id;
}

function closeFeed() {
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  hideFeed();
}

function closeSingle() {
  location.hash = "#feed";
}

function routeFromHash() {
  const h = location.hash;
  const post = /^#post-(\d{1,12})$/.exec(h);
  if (h === "#feed") showFeed();
  else if (post) showPost(Number(post[1]));
  else hideFeed();
}

// the writing box is made again each time the page opens, so it starts with your usual audience
function mountCompose() {
  $("feed-compose-slot").replaceChildren(
    makeComposer({
      onDone: (post) => {
        if (feed.tab === "all" || feed.tab === "mine" || (feed.tab === "close" && post.audience === "close")) feed.posts.unshift(post);
        renderFeed();
        const first = $("feed-list").firstChild;
        if (first && first.classList) first.classList.add("is-new");
      },
    })
  );
}

for (const b of document.querySelectorAll("#feed-tabs button")) {
  b.onclick = () => {
    feed.tab = b.dataset.tab;
    paintTabs();
    feed.posts = [];
    renderFeed();
    loadFeed(false);
  };
}

$("feed-btn").onclick = openFeed;
$("feed-close").onclick = closeFeed;
$("feed-back-feed").onclick = closeSingle;
$("feed-refresh").onclick = () => {
  setNewCount(0);
  feed.single != null ? loadSingle(feed.single) : loadFeed(false);
};
$("feed-new").onclick = () => {
  setNewCount(0);
  loadFeed(false);
  window.scrollTo({ top: 0 });
};
$("feed-more").onclick = () => loadFeed(true);
$("feed-post-settings").onclick = () => openSettings("posts");
window.addEventListener("hashchange", routeFromHash);

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !feed.open || dialogStack.length) return;
  // a profile page or the settings opened from the feed sit on top and close first
  for (const id of ["profile-overlay", "settings-overlay", "lists-overlay"]) {
    const o = document.getElementById(id);
    if (o && !o.hidden) return;
  }
  closeFeed();
});

// "5 min ago" goes stale while the page stays open, so the times are redrawn each minute
setInterval(() => {
  if (!feed.open) return;
  for (const card of document.querySelectorAll("#feed-list .feed-post")) {
    const post = feed.posts.find((p) => String(p.id) === card.dataset.id);
    const sub = card.querySelector(".feed-head .feed-sub");
    if (post && sub && sub.firstChild) sub.firstChild.textContent = postSub(post);
  }
}, 60000);

// ---------- for moderators: reported posts ----------

async function loadReports() {
  const box = $("feed-admin-list");
  try {
    const data = await api("/api/admin/reports");
    $("feed-admin-count").textContent = String(data.reports.length);
    box.replaceChildren();
    if (!data.reports.length) return box.append(el("p", "list-empty", "Nothing waiting."));
    for (const r of data.reports) box.append(reportCard(r));
  } catch {
    box.replaceChildren(el("p", "list-empty", "couldn't load the reports"));
  }
}

function reportCard(r) {
  const card = el("div", "admin-report");
  const reasons = Object.entries(r.reasons).map(([k, n]) => k + " \u00d7" + n).join(", ");
  card.append(postHead(r.post), ...postBody(r.post));
  card.append(el("p", "pf-hint", r.reports + " report" + (r.reports === 1 ? "" : "s") + ": " + reasons + (r.hidden ? " (hidden)" : "")));
  const act = async (path, method) => {
    try {
      await sendJson(path, method);
      loadReports();
      if (feed.single == null) loadFeed(false);
    } catch (ex) {
      feedError(ex.message);
    }
  };
  const row = el("div", "feed-actions");
  row.append(
    plainButton("Keep it", () => act("/api/admin/posts/" + r.post.id + "/keep", "POST")),
    plainButton("Remove it", () => confirm("Delete this post for good?") && act("/api/admin/posts/" + r.post.id, "DELETE"), "danger")
  );
  card.append(row);
  return card;
}

// routeFromHash() is called at the end of feed-compose.js, once the writing box exists
