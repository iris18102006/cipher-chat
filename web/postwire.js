// A feed post sent in a chat. Only the number of the post travels inside the encrypted message;
// the post itself is fetched from the server when it is shown, and the server only gives it to
// people who may see it. So sending a post to somebody never lets them read what they couldn't.
// This file has no page code, so it can run in the tests too.

const POST_PREFIX = "\u0001post:"; // a chat message that starts like this is a post, not text

function postWire(id) {
  return POST_PREFIX + JSON.stringify({ v: 1, id });
}

// The other side of postWire. A message from somebody else is not to be trusted: anything that
// isn't exactly a post number gives null and is shown as plain text.
function postParse(text) {
  if (typeof text !== "string" || !text.startsWith(POST_PREFIX)) return null;
  let d;
  try {
    d = JSON.parse(text.slice(POST_PREFIX.length));
  } catch {
    return null;
  }
  if (!d || typeof d !== "object" || d.v !== 1) return null;
  if (!Number.isSafeInteger(d.id) || d.id < 1) return null;
  return { id: d.id };
}
