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

function shareDialog(post) {
  const box = el("div", "share-box");
  box.append(el("p", "pf-hint", "Pick who gets this post in a chat. It's sent end-to-end encrypted, and they can only open it if they're allowed to see it."));
  const search = el("input", "share-search");
  search.type = "text";
  search.placeholder = "search friends and groups...";
  search.setAttribute("aria-label", "search friends and groups");
  const list = el("div", "share-list");
  const picked = new Set();
  const note = el("textarea", "share-note");
  note.rows = 2;
  note.maxLength = 300;
  note.placeholder = "add a message (optional)";
  note.setAttribute("aria-label", "message to send with the post");
  const err = el("p", "fc-error");
  err.hidden = true;
  const go = el("button", "fc-submit", "Send");
  go.type = "button";
  go.disabled = true;
  const targets = shareTargets();

  const paintList = () => {
    const q = search.value.trim().toLowerCase();
    const shown = targets.filter((t) => !q || t.name.toLowerCase().includes(q) || t.sub.toLowerCase().includes(q));
    list.replaceChildren();
    if (!shown.length) list.append(el("p", "list-empty", targets.length ? "nobody matches" : "no friends or groups to send it to yet"));
    for (const t of shown) {
      const row = el("label", "share-row");
      const input = el("input");
      input.type = "checkbox";
      input.checked = picked.has(t.key);
      input.onchange = () => {
        if (input.checked) picked.add(t.key);
        else picked.delete(t.key);
        go.disabled = picked.size === 0;
        go.textContent = picked.size > 1 ? "Send to " + picked.size : "Send";
      };
      const who = el("span", "who");
      who.append(el("b", "", t.name), el("small", "", t.sub));
      row.append(input, t.person ? avatarNode(t.person, "small") : shareGroupIcon(), who);
      list.append(row);
    }
  };
  search.oninput = paintList;

  go.onclick = async () => {
    go.disabled = true;
    err.hidden = true;
    const failed = [];
    let sent = 0;
    const words = note.value.trim();
    for (const t of targets.filter((x) => picked.has(x.key))) {
      const target = t.group ? { peer: null, group: t.group.id } : { peer: t.person.username, group: null };
      try {
        let ok = await sendWire(target, postWire(post.id));
        if (ok && words) ok = await sendWire(target, words);
        if (ok) sent++;
        else failed.push(t.name);
      } catch {
        failed.push(t.name);
      }
    }
    if (!failed.length) {
      dlg.close();
      toast(sent === 1 ? "Post sent" : "Post sent to " + sent + " chats");
      return;
    }
    err.textContent = "Couldn't send it to: " + failed.join(", ") + ".";
    err.hidden = false;
    for (const t of targets) if (!failed.includes(t.name)) picked.delete(t.key);
    paintList();
    go.disabled = picked.size === 0;
  };

  box.append(search, list, note, err, go);
  paintList();
  const dlg = openDialog("Share post", box);
}

// ---------- a post inside a chat ----------

const postCardCache = new Map(); // post id -> a promise for what the server said, kept briefly

function fetchPostForChat(id) {
  const hit = postCardCache.get(id);
  if (hit && Date.now() - hit.at < 30000) return hit.job;
  const job = api("/api/posts/" + id);
  postCardCache.set(id, { at: Date.now(), job });
  job.catch(() => postCardCache.delete(id));
  return job;
}

// the little card that stands for a post in a chat bubble
function postCardNode(ref) {
  const card = el("div", "chat-post");
  card.append(el("div", "chat-post-note", "loading post..."));
  fetchPostForChat(ref.id)
    .then((p) => {
      const open = plainButton("", () => openPostPage(ref.id), "chat-post-open");
      open.append(avatarNode(p.author, "small"));
      const text = el("span", "chat-post-text");
      text.append(el("b", "", shownName(p.author)));
      let body = p.body;
      if (p.is_repost && p.original && p.original.body && !body) body = p.original.body;
      if (body) text.append(el("span", "chat-post-body", body.length > 140 ? body.slice(0, 140) + "\u2026" : body));
      const media = (p.media && p.media.length ? p.media : p.original && p.original.media) || [];
      const pic = media.find((m) => m.kind === "image" && safeMedia(m.url));
      if (pic) {
        const img = el("img", "chat-post-pic");
        img.src = pic.url;
        img.alt = "";
        img.loading = "lazy";
        open.append(img);
      } else if (media.length) {
        text.append(el("span", "chat-post-body", media[0].kind === "video" ? "\u{1f3ac} video" : "\u{1f3b5} song"));
      }
      open.append(text);
      card.replaceChildren(el("div", "chat-post-label", "\u2708 shared a post"), open);
    })
    .catch(() => {
      card.replaceChildren(el("div", "chat-post-note", "This post isn't available to you. It may have been deleted, or it isn't shared with you."));
    });
  return card;
}
