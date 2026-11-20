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

// Saves one or more settings, tells the person how it went, and puts the old choice back if it fails.
async function saveSetting(status, patch) {
  status.className = "";
  status.textContent = "saving...";
  try {
    const fresh = await api("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (typeof feed !== "undefined") feed.settings = fresh;
    status.textContent = "saved";
    return fresh;
  } catch {
    status.className = "bad";
    status.textContent = "couldn't save that, try again";
    return null;
  }
}

// a group of radio buttons that saves when you pick one
function radioGroup(legend, name, options, current, status, field, after) {
  const box = el("fieldset");
  box.append(el("legend", "", legend));
  for (const [value, label, hint] of options) {
    const row = el("label", "opt");
    const input = el("input");
    input.type = "radio";
    input.name = name;
    input.value = value;
    input.checked = value === current;
    input.onchange = async () => {
      const fresh = await saveSetting(status, { [field]: value });
      if (fresh) {
        current = value;
        if (after) after(value);
      } else {
        for (const other of box.querySelectorAll("input")) other.checked = other.value === current;
      }
    };
    const text = el("span");
    text.append(label);
    text.append(el("small", "", hint));
    row.append(input, text);
    box.append(row);
  }
  return box;
}

// an on/off switch that saves when you click it
function toggleRow(label, hint, current, status, field) {
  const row = el("label", "opt");
  const input = el("input");
  input.type = "checkbox";
  input.checked = current;
  input.onchange = async () => {
    const fresh = await saveSetting(status, { [field]: input.checked });
    if (fresh) current = input.checked;
    else input.checked = current;
  };
  const text = el("span");
  text.append(label);
  text.append(el("small", "", hint));
  row.append(input, text);
  return row;
}

// the friends you share "close friends" posts with
async function closeFriendsBox(status) {
  const box = el("fieldset");
  box.id = "settings-close-friends";
  box.append(el("legend", "", "Close friends"));
  box.append(el("p", "pf-hint", "Posts you make for close friends only are shown to these people and nobody else. They aren't told they're on the list."));
  const list = el("div", "settings-friends");
  box.append(list);
  let friends = [];
  try {
    friends = (await api("/api/close-friends")).friends;
  } catch {
    list.append(el("p", "list-empty", "couldn't load your friends"));
    return box;
  }
  if (!friends.length) list.append(el("p", "list-empty", "You don't have any friends to pick from yet."));
  const saved = () => friends.filter((f) => f.close).map((f) => f.username);
  for (const f of friends) {
    const row = el("label", "share-row");
    const input = el("input");
    input.type = "checkbox";
    input.checked = f.close;
    input.onchange = async () => {
      f.close = input.checked;
      status.className = "";
      status.textContent = "saving...";
      try {
        await sendJson("/api/close-friends", "PUT", { usernames: saved() });
        status.textContent = "saved";
      } catch (ex) {
        f.close = !input.checked;
        input.checked = f.close;
        status.className = "bad";
        status.textContent = ex.message;
      }
    };
    const who = el("span", "who");
    who.append(el("b", "", shownName(f)), el("small", "", "@" + f.username));
    row.append(input, avatarNode(f, "small"), who);
    list.append(row);
  }
  return box;
}

