// Settings: what happens to messages from people whose friend request you haven't accepted.
// Loaded last. Uses $, el, api, toast and loadContacts from app.js.

const POLICY_OPTIONS = [
  ["allow", "Let them message me", "Messages arrive right away, even before I accept."],
  ["ask", "Ask me first", "Their messages wait (up to 3) and I only see them when I accept the request."],
  ["wait", "Make them wait", "They can't message me until I accept the request."],
];

let settingsReturnFocus = null;

function closeSettings() {
  $("settings-overlay").hidden = true;
  if (settingsReturnFocus && document.contains(settingsReturnFocus)) settingsReturnFocus.focus();
  settingsReturnFocus = null;
}

async function openSettings() {
  settingsReturnFocus = document.activeElement;
  $("settings-overlay").hidden = false;
  $("settings-close").focus();
  const body = $("settings-body");
  body.replaceChildren(el("p", "", "loading..."));
  let current;
  try {
    current = (await api("/api/settings")).message_policy;
  } catch {
    body.replaceChildren(el("p", "", "couldn't load your settings."));
    return;
  }

  const box = el("fieldset");
  box.append(el("legend", "", "Messages before I accept a friend request"));
  const status = el("p");
  status.id = "settings-status";
  status.setAttribute("role", "status");
  for (const [value, label, hint] of POLICY_OPTIONS) {
    const row = el("label", "opt");
    const input = el("input");
    input.type = "radio";
    input.name = "message_policy";
    input.value = value;
    input.checked = value === current;
    input.onchange = async () => {
      status.className = "";
      status.textContent = "saving...";
      try {
        await api("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message_policy: value }),
        });
        current = value;
        status.textContent = "saved";
        // "let them message me" lets waiting messages through, so refresh the buddy list
        if (value === "allow") loadContacts();
      } catch {
        status.className = "bad";
        status.textContent = "couldn't save that, try again";
        for (const other of box.querySelectorAll("input")) other.checked = other.value === current;
      }
    };
    const text = el("span");
    text.append(label);
    text.append(el("small", "", hint));
    row.append(input, text);
    box.append(row);
  }
  body.replaceChildren(box, status);
}

$("settings-btn").onclick = openSettings;
$("settings-close").onclick = closeSettings;
$("settings-overlay").addEventListener("click", (e) => {
  if (e.target === $("settings-overlay")) closeSettings();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("settings-overlay").hidden) closeSettings();
});
