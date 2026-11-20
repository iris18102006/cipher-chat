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

