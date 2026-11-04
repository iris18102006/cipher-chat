// Two panels from the top bar: friend requests, and the people you blocked.
// Loaded after settings.js. Uses $, el, api, state, toast, loadContacts, setBlocked from app.js
// and avatarNode, shownName, openProfile from profile.js.

let listsKind = null; // "requests", "blocked" or null when closed
let listsReturnFocus = null;

function closeLists() {
  $("lists-overlay").hidden = true;
  listsKind = null;
  if (listsReturnFocus && document.contains(listsReturnFocus)) listsReturnFocus.focus();
  listsReturnFocus = null;
}

function listButton(label, onClick) {
  const b = el("button", "", label);
  b.type = "button";
  b.onclick = onClick;
  return b;
}

function personRow(p, note, buttons) {
  const row = el("div", "list-row");
  row.append(avatarNode(p, "small"));
  const who = el("div", "who");
  who.append(el("b", "", shownName(p)), el("small", "", "@" + p.username + (note ? " - " + note : "")));
  const btns = el("div", "btns");
  btns.append(...buttons);
  row.append(who, btns);
  return row;
}

function listSection(title, rows, emptyText) {
  const box = el("div");
  box.append(el("h3", "", title));
  if (rows.length) box.append(...rows);
  else box.append(el("p", "list-empty", emptyText));
  return box;
}

async function paintLists() {
  const body = $("lists-body");
  const err = el("p");
  err.id = "lists-error";
  // run one action, then reload everything so the panel and the buddy list match
  const act = (fn) => async () => {
    err.textContent = "";
    try {
      await fn();
      await loadContacts();
      await paintLists();
    } catch (ex) {
      err.textContent = whyFailed(ex, "that didn't work, try again");
    }
  };
  const call = (method, path) => () => api(path, { method });
  const friend = (u) => "/api/friends/" + encodeURIComponent(u);
  const profile = (u) => listButton("Profile", () => { closeLists(); openProfile(u); });

  try {
    if (listsKind === "requests") {
      const { incoming, outgoing } = await api("/api/friends");
      const got = incoming.map((p) => {
        const c = state.contacts.get(p.username);
        const note = c && c.held ? "wrote " + c.held + " message" + (c.held > 1 ? "s" : "") : "";
        return personRow(p, note, [
          listButton("Accept", act(call("POST", friend(p.username) + "/accept"))),
          listButton("Decline", act(call("DELETE", friend(p.username)))),
          profile(p.username),
        ]);
      });
      const sent = outgoing.map((p) =>
        personRow(p, "waiting", [listButton("Cancel request", act(call("DELETE", friend(p.username)))), profile(p.username)])
      );
      body.replaceChildren(
        listSection("Want to be your friend", got, "No friend requests right now."),
        listSection("Requests you sent", sent, "You haven't sent any requests."),
        err
      );
    } else if (listsKind === "blocked") {
      const people = await api("/api/blocks");
      const rows = people.map((p) =>
        personRow(p, "", [
          listButton("Unblock", async () => {
            err.textContent = "";
            await setBlocked(p.username, false);
            await paintLists();
          }),
          profile(p.username),
        ])
      );
      body.replaceChildren(
        el("p", "list-empty", "People you block can't message you, can't see when you're online, and can't see your profile."),
        listSection("Blocked people", rows, "You haven't blocked anyone."),
        err
      );
    }
  } catch {
    body.replaceChildren(el("p", "list-empty", "couldn't load this, close it and try again."));
  }
}

async function openLists(kind) {
  if ($("lists-overlay").hidden) listsReturnFocus = document.activeElement;
  listsKind = kind;
  $("lists-title").textContent = kind === "requests" ? "Friend requests" : "Blocked people";
  $("lists-overlay").hidden = false;
  $("lists-close").focus();
  $("lists-body").replaceChildren(el("p", "list-empty", "loading..."));
  await paintLists();
}

// called when something changed behind the panel's back (a new request came in...)
async function refreshLists() {
  if (listsKind) await paintLists();
}

$("requests-btn").onclick = () => openLists("requests");
$("blocked-btn").onclick = () => openLists("blocked");
$("lists-close").onclick = closeLists;
$("lists-overlay").addEventListener("click", (e) => {
  if (e.target === $("lists-overlay")) closeLists();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("lists-overlay").hidden) closeLists();
});
