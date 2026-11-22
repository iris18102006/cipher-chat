// Comments under posts. The Comment button under a post opens the thread: older comments on top,
// a box to write at the bottom. You can edit and delete your own comments, and the person whose
// post it is can delete any comment under it.
// Loaded after feed.js and before feed-compose.js. Uses $, el, api, toast, whyFailed, parseTs from
// app.js, sendJson from profile-media.js, avatarNode, shownName, openProfile from profile.js,
// feed, postAgo, paintEngage from feed.js and icon, iconButton from icons.js.
//
// A comment only ever goes in with textContent, never innerHTML, so nothing a friend writes can
// run as code.

const COMMENT_MAX = 300;
const commentState = {
  open: new Set(), // ids of the posts whose thread is showing
  data: new Map(), // post id -> { list, more, loaded, loading, error, draft }
};

function commentsFor(id) {
  if (!commentState.data.has(id)) commentState.data.set(id, { list: [], more: false, loaded: false, loading: false, error: "", draft: "" });
  return commentState.data.get(id);
}

function commentsOpen(p) {
  return commentState.open.has(p.id);
}

function commentLabel(p) {
  return "Comment" + (p.comments ? " " + p.comments : "");
}

// the post on screen with this id (and every copy of it that is a repost's original)
function postOnScreen(id) {
  for (const q of feed.posts) {
    if (q.id === id) return q;
    if (q.is_repost && q.original && q.original.id === id) return q.original;
  }
  return null;
}

function repaintComments(id) {
  const p = postOnScreen(id);
  if (!p) return;
  for (const card of document.querySelectorAll('#feed-list .feed-post[data-id="' + id + '"]')) {
    paintComments(card, p);
    paintEngage(card, p);
  }
}

function toggleComments(card, p) {
  if (commentState.open.has(p.id)) commentState.open.delete(p.id);
  else commentState.open.add(p.id);
  paintComments(card, p);
  paintEngage(card, p);
  if (commentState.open.has(p.id)) {
    const box = card.querySelector(".fcm-input");
    if (box) box.focus();
  }
}

async function loadComments(p, older) {
  const st = commentsFor(p.id);
  if (st.loading) return;
  st.loading = true;
  st.error = "";
  repaintComments(p.id);
  try {
    const q = new URLSearchParams();
    if (older && st.list.length) q.set("before", String(st.list[0].id));
    const data = await api("/api/posts/" + p.id + "/comments?" + q);
    st.list = older ? data.comments.concat(st.list) : data.comments;
    st.more = data.more;
    st.loaded = true;
    p.comments = Math.max(p.comments || 0, st.list.length);
  } catch (ex) {
    st.error = whyFailed(ex, "couldn't load the comments, try again");
  } finally {
    st.loading = false;
  }
  repaintComments(p.id);
}

// ---------- one comment ----------

function commentNode(p, c) {
  const row = el("div", "fcm-row" + (c.mine ? " mine" : ""));
  row.dataset.id = String(c.id);
  const avatar = avatarNode(c.author, "small");
  avatar.onclick = () => openProfile(c.author.username);
  const main = el("div", "fcm-main");
  const head = el("div", "fcm-head");
  const name = el("b", "", shownName(c.author));
  name.onclick = () => openProfile(c.author.username);
  head.append(name, el("small", "fcm-time", postAgo(c.created_at) + (c.edited ? " \u00b7 edited" : "")));
  const text = el("p", "fcm-text", c.body);
  main.append(head, text);
  if (c.mine || c.can_delete) {
    const acts = el("div", "fcm-actions");
    if (c.mine) acts.append(iconButton("edit", "Edit", () => editComment(p, c, row), "fcm-act"));
    acts.append(iconButton("trash", "Delete", () => deleteComment(p, c), "fcm-act danger"));
    main.append(acts);
  }
  row.append(avatar, main);
  return row;
}

// the words turn into a little box, with Save and Cancel
function editComment(p, c, row) {
  const text = row.querySelector(".fcm-text");
  const acts = row.querySelector(".fcm-actions");
  const form = el("form", "fcm-edit");
  const input = el("textarea", "fcm-input");
  input.maxLength = COMMENT_MAX;
  input.rows = 2;
  input.value = c.body;
  input.setAttribute("aria-label", "edit your comment");
  const err = el("p", "fc-error");
  err.hidden = true;
  const save = iconButton("check", "Save", null, "fcm-save");
  save.type = "submit";
  const cancel = iconButton("x", "Cancel", () => repaintComments(p.id), "fcm-act");
  const bar = el("div", "fcm-actions");
  bar.append(save, cancel);
  form.append(input, err, bar);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const words = input.value.trim();
    if (!words) {
      err.textContent = "a comment needs some words, or delete it";
      err.hidden = false;
      return;
    }
    save.disabled = true;
    try {
      const fresh = await sendJson("/api/comments/" + c.id, "PATCH", { body: words });
      const st = commentsFor(p.id);
      st.list = st.list.map((x) => (x.id === c.id ? fresh : x));
      repaintComments(p.id);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      save.disabled = false;
    }
  };
  text.replaceWith(form);
  if (acts) acts.remove();
  input.focus();
}
