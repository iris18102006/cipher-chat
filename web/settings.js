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

