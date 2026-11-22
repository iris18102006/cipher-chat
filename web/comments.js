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
