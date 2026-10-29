// Friend requests as buttons on someone's profile.
// Loaded after profile.js. Uses $, el, api, state, loadContacts, openChat from app.js
// and openProfile / closeProfile from profile.js.

function socialButton(label, onClick, extra) {
  const b = el("button", extra || "", label);
  b.type = "button";
  b.onclick = onClick;
  return b;
}

// run one friend action, then reload the buddy list and the profile you're looking at
async function socialCall(method, path, username, errBox) {
  errBox.textContent = "";
  try {
    await api(path, { method });
    await loadContacts();
    await openProfile(username);
  } catch (ex) {
    errBox.textContent = "that didn't work, try again";
  }
}

function addSocialButtons(p, actions) {
  if (p.me) return;
  const err = el("span", "pf-inline-error");
  const base = "/api/friends/" + encodeURIComponent(p.username);
  const go = (method, path) => () => socialCall(method, path, p.username, err);

  actions.append(
    socialButton("Message", () => {
      closeProfile();
      openChat(p.username);
    })
  );

  if (p.friend === "none") {
    actions.append(socialButton("Add friend", go("POST", base)));
  } else if (p.friend === "outgoing") {
    actions.append(socialButton("Request sent", () => {}, "static"));
    actions.append(socialButton("Cancel request", go("DELETE", base)));
  } else if (p.friend === "incoming") {
    actions.append(socialButton("Accept friend request", go("POST", base + "/accept")));
    actions.append(socialButton("Decline", go("DELETE", base)));
  } else if (p.friend === "friends") {
    actions.append(socialButton("\u2713 Friends", () => {}, "static"));
    actions.append(socialButton("Unfriend", go("DELETE", base)));
  }
  actions.append(err);
}
