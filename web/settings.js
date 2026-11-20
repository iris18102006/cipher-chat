// Settings: messages from people you haven't accepted yet, and everything about your posts
// (who sees them, who sees the likes, reposts and sharing, close friends).
// Loaded after friends.js. Uses $, el, api, toast and loadContacts from app.js, avatarNode and
// shownName from profile.js and plainButton from dialogs.js.

const POLICY_OPTIONS = [
  ["allow", "Let them message me", "Messages arrive right away, even before I accept."],
  ["ask", "Ask me first", "Their messages wait (up to 3) and I only see them when I accept the request."],
  ["wait", "Make them wait", "They can't message me until I accept the request."],
];

const POST_AUDIENCE_OPTIONS = [
  ["friends", "All my friends", "Every friend can see it. This is how posts work unless you pick something else."],
  ["close", "Close friends only", "Only the friends on your close friends list below."],
  ["me", "Only me", "Nobody else. Handy as a private diary."],
];

const LIKES_OPTIONS = [
  ["everyone", "Everyone who can see the post", "They see how many likes it has and who liked it."],
  ["count", "Only the number", "Others see how many likes there are, and only you see the names."],
  ["private", "Only me", "Nobody else sees the likes at all, not even the number."],
];

let settingsReturnFocus = null;

function closeSettings() {
  $("settings-overlay").hidden = true;
  if (settingsReturnFocus && document.contains(settingsReturnFocus)) settingsReturnFocus.focus();
  settingsReturnFocus = null;
}

