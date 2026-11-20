// Sending a post to chats ("Share"), and how a post looks when it arrives in a chat.
// Loaded after feed.js and attachments.js. Uses $, el, api, state, toast from app.js,
// sendWire (attachments.js), shownName/avatarNode (profile.js), postWire/postParse (postwire.js).
//
// What travels in the chat is only the post's number, inside the encrypted message. The post is
// fetched when it is shown, and the server only hands it over to people who may see it.

// ---------- the Share window ----------

function shareTargets() {
  const out = [];
  for (const c of state.contacts.values()) {
    if (c.friend === "friends" && !c.blocked && c.pub && !c.changed) {
      out.push({ key: "u:" + c.username, name: shownName(c), sub: "@" + c.username, person: c });
    }
  }
  for (const g of state.groups.values()) {
    out.push({ key: "g:" + g.id, name: g.name, sub: "group", group: g });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

