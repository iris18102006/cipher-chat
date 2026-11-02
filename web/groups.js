// Group chats: the buddy list section, the chat pane in group mode, live events,
// and the panel for making a group and managing its members.
// Loaded after lists.js. Uses $, el, api, state, toast, sendWS, renderMessages, loadContacts...
// from app.js, avatarNode / shownName from profile.js and personRow / listSection from lists.js.
// The crypto (generateGroupKey, wrapGroupKey...) is in crypto.js.

const GROUP_EVENTS = ["gmsg", "gtyping", "gseen", "gread-sync", "group", "gmsg-rejected"];
const GROUP_NAME_MAX = 40;

// ---------- small helpers ----------

// like api(), but keeps the server's reason ("you can only add your friends") for the toast
async function gapi(path, method, body) {
  const res = await fetch(path, {
    method: method || "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.href = "/login.html";
    throw new Error("not logged in");
  }
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const err = new Error(data && typeof data.detail === "string" ? data.detail : "that didn't work, try again");
    err.status = res.status;
    throw err;
  }
  return data;
}

// Same trust-on-first-use as the 1:1 chats (same storage slot): the first key we see
// for a person is remembered, and if it ever changes we stop using it until it's verified.
function pubState(username, pub) {
  if (username === state.me) return "ok";
  let known = null;
  try {
    known = localStorage.getItem(knownSlot(username));
  } catch {}
  if (!known) {
    try {
      localStorage.setItem(knownSlot(username), pub);
    } catch {}
    return "ok";
  }
  return known === pub ? "ok" : "changed";
}

function memberName(gid, username) {
  const d = state.gDetail.get(gid);
  const m = d && d.members.find((x) => x.username === username);
  return m ? shownName(m) : username;
}

function groupNode(g) {
  // the group's "picture" is the first letter of its name
  const av = avatarNode({ username: g.name, display_name: g.name, avatar: "" }, "tiny");
  av.classList.add("group");
  return av;
}

// ---------- keys ----------

// The group key of one version, unwrapped for me. Null if I don't hold it or the person
// who wrapped it has a key that changed since we first saw it.
async function groupKey(gid, version) {
  const id = gid + ":" + version;
  if (state.gKeys.has(id)) return state.gKeys.get(id);
  const d = state.gDetail.get(gid);
  const w = d && d.keys.find((k) => k.version === version);
  if (!w) return null;
  try {
    if (pubState(w.from, w.from_pub) === "changed") return null;
    const wrapKey = await deriveSharedKey(state.identity.privateKey, await importPub(w.from_pub), GROUP_WRAP_INFO);
    const key = await unwrapGroupKey(wrapKey, w.iv, w.wk);
    state.gKeys.set(id, key);
    return key;
  } catch {
    return null;
  }
}

// wrap a fresh group key for everyone in `members` ([{ username, pub }])
async function wrapForMembers(members, key) {
  const out = [];
  for (const m of members) {
    if (!m.pub) throw new Error(m.username + " hasn't opened cipher-chat since encryption was set up, so they have no key yet.");
    if (pubState(m.username, m.pub) === "changed") {
      throw new Error(m.username + "'s encryption key changed. Verify it in the group's member list first.");
    }
    const wrapKey = await deriveSharedKey(state.identity.privateKey, await importPub(m.pub), GROUP_WRAP_INFO);
    out.push({ user: m.username, ...(await wrapGroupKey(wrapKey, key)) });
  }
  return out;
}

function membersWithPubs(d) {
  return d.members.map((m) => ({ username: m.username, pub: m.username === state.me ? state.myPub : m.pub }));
}

// ---------- loading ----------

async function loadGroups() {
  const list = await api("/api/groups");
  const prev = state.groups;
  state.groups = new Map();
  for (const row of list) {
    const old = prev.get(row.id);
    state.groups.set(row.id, {
      ...row,
      typing: old ? old.typing : new Map(),
      canWrite: old ? old.canWrite : false, // set once the key for the current version is unwrapped
    });
  }
  if (state.openGroup != null && !state.groups.has(state.openGroup)) closeGroupChat();
  renderBuddies();
  if (state.openGroup != null) renderChatHeader();
  for (const g of state.groups.values()) maybeRekey(g);
}

async function loadGroupDetail(gid) {
  const d = await api("/api/groups/" + gid);
  state.gDetail.set(gid, d);
  const g = state.groups.get(gid);
  if (g) {
    g.name = d.name;
    g.owner = d.owner;
    g.key_version = d.key_version;
    g.rekey_needed = d.rekey_needed;
    g.members = d.members.length;
  }
  return d;
}

async function decryptGroupRows(gid, rows) {
  const out = [];
  for (const r of rows) {
    let text;
    let failed = false;
    try {
      const key = await groupKey(gid, r.v);
      if (!key) throw new Error("no key");
      text = await decryptText(key, r.iv, r.ct);
    } catch {
      text = "can't decrypt this message (missing key, or the sender's key changed)";
      failed = true;
    }
    out.push({ id: r.id, from: r.from, text, failed, ts: r.ts, v: r.v, seen: new Set(r.seen_by || []) });
  }
  return out;
}

async function loadGroupHistory(gid) {
  await loadGroupDetail(gid);
  const rows = await api("/api/groups/" + gid + "/messages?limit=" + PAGE);
  state.gmsgs.set(gid, await decryptGroupRows(gid, rows));
  state.gHasOlder.set(gid, rows.length === PAGE);
  const g = state.groups.get(gid);
  if (g) g.canWrite = !!(await groupKey(gid, g.key_version));
}

async function loadOlderGroup() {
  const gid = state.openGroup;
  const list = state.gmsgs.get(gid) || [];
  if (gid == null || !list.length) return;
  const rows = await api("/api/groups/" + gid + "/messages?limit=" + PAGE + "&before=" + list[0].id);
  state.gmsgs.set(gid, [...(await decryptGroupRows(gid, rows)), ...list]);
  state.gHasOlder.set(gid, rows.length === PAGE);
  renderMessages(true);
}

// ---------- buddy list ----------

function groupTypingText(g) {
  const names = [...g.typing.keys()].map((u) => memberName(g.id, u));
  if (!names.length) return "";
  if (names.length === 1) return names[0] + " is typing";
  if (names.length === 2) return names[0] + " and " + names[1] + " are typing";
  return "several people are typing";
}

function groupRow(g) {
  const li = el("li", g.id === state.openGroup ? "active" : "");
  li.dataset.group = String(g.id);
  li.append(groupNode(g));
  const info = el("div", "buddy-info");
  info.append(el("div", "buddy-name", g.name));
  const typing = groupTypingText(g);
  info.append(el("div", "buddy-sub", typing ? typing + "..." : g.members + " members"));
  li.append(info);
  if (g.unread > 0) li.append(el("span", "badge", g.unread > 99 ? "99+" : String(g.unread)));
  li.onclick = () => openGroupChat(g.id);
  return li;
}

// the "Groups" section at the top of the buddy list: { nodes, count }
function groupSection(q) {
  const rows = [...state.groups.values()]
    .filter((g) => !q || g.name.toLowerCase().includes(q))
    // most recent conversation first, groups nobody wrote in yet by name
    .sort((a, b) => (b.last_msg || 0) - (a.last_msg || 0) || a.name.localeCompare(b.name));
  if (!rows.length) return { nodes: [], count: 0 };
  return { nodes: [el("li", "group groups", "Groups (" + rows.length + ")"), ...rows.map(groupRow)], count: rows.length };
}

function totalGroupUnread() {
  let n = 0;
  for (const g of state.groups.values()) n += g.unread;
  return n;
}

// ---------- the chat pane in group mode ----------

function renderGroupHeader() {
  const g = state.groups.get(state.openGroup);
  if (!g) return;
  $("chat-name").textContent = g.name;
  $("chat-name").title = "";
  const typing = groupTypingText(g);
  $("chat-status").textContent = typing ? typing + "..." : g.members + " members";
  $("chat-status").className = "";
  for (const id of ["view-profile", "verify", "block"]) $(id).hidden = true;
  $("group-info").hidden = false;
  for (const id of ["key-warning", "block-banner", "request-banner", "verify-box"]) $(id).hidden = true;
  $("typing").hidden = !typing;
  $("typing-name").textContent = typing;
  // waiting on a new key (someone just left, or just joined): can't write until it arrives
  $("msg").disabled = !g.canWrite;
  $("send").disabled = !g.canWrite;
  $("msg").placeholder = g.canWrite
    ? "type a message (Enter to send, Shift+Enter for a new line)"
    : "you don't have this group's key yet...";
}

async function openGroupChat(gid) {
  stopTyping();
  state.open = null;
  state.openGroup = gid;
  document.body.classList.add("in-chat");
  $("chat-empty").hidden = true;
  $("chat-pane").hidden = false;
  $("verify-box").hidden = true;
  $("msg").value = "";
  autosize();
  renderChatHeader();
  renderBuddies();
  try {
    await loadGroupHistory(gid);
  } catch {
    return;
  }
  if (state.openGroup !== gid) return; // clicked something else while loading
  renderChatHeader();
  renderMessages();
  scrollBottom();
  markGroupRead(gid);
  if (!$("msg").disabled) $("msg").focus();
}

// leave the group view (the group is gone, or we're going back to the list)
function closeGroupChat() {
  stopTyping();
  state.openGroup = null;
  $("group-info").hidden = true;
  $("chat-pane").hidden = true;
  $("chat-empty").hidden = false;
  document.body.classList.remove("in-chat");
}

function markGroupRead(gid) {
  const g = state.groups.get(gid);
  if (!g) return;
  if (g.unread === 0) return;
  g.unread = 0;
  sendWS({ type: "gread", group: gid });
  renderBuddies();
}

async function sendGroupMessage() {
  const gid = state.openGroup;
  const text = $("msg").value.trim();
  const g = state.groups.get(gid);
  const d = state.gDetail.get(gid);
  if (gid == null || !text || !g || !d) return;
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    setConn(false, "offline, message not sent");
    return;
  }
  const key = await groupKey(gid, d.key_version);
  if (!key) {
    toast("you don't have this group's key yet, give it a second");
    return;
  }
  const { iv, ct } = await encryptText(key, text);
  if (sendWS({ type: "gmsg", group: gid, v: d.key_version, iv, ct, cid: crypto.randomUUID() })) {
    $("msg").value = "";
    autosize();
    stopTyping();
  }
}

// "sent" -> "seen by 2" under my own messages
function groupTick(m) {
  const gid = state.openGroup;
  const d = state.gDetail.get(gid);
  const others = d ? d.members.length - 1 : 0;
  if (!m.seen || m.seen.size === 0) return { text: "\u2713 sent", cls: "tick" };
  const all = others > 0 && m.seen.size >= others;
  return {
    text: "\u2713\u2713 seen by " + (all ? "everyone" : m.seen.size),
    cls: "tick read",
    title: [...m.seen].map((u) => memberName(gid, u)).join(", "),
  };
}

// ---------- live events ----------

function setGroupTyping(gid, user, on) {
  const g = state.groups.get(gid);
  if (!g) return;
  clearTimeout(g.typing.get(user));
  if (on) g.typing.set(user, setTimeout(() => setGroupTyping(gid, user, false), 5000));
  else g.typing.delete(user);
  renderBuddies();
  if (state.openGroup === gid) {
    renderGroupHeader();
    if (on && nearBottom()) scrollBottom();
  }
}

async function handleGroupWS(data) {
  const gid = data.group;
  if (data.type === "gmsg") {
    if (!state.groups.has(gid)) await loadGroups();
    const g = state.groups.get(gid);
    if (!g) return;
    const mine = data.from === state.me;
    const list = state.gmsgs.get(gid);
    if (list && !list.some((m) => m.id === data.id)) {
      // a message with a key version we haven't fetched yet (the key was just replaced)
      if (!(await groupKey(gid, data.v))) await loadGroupDetail(gid);
      const [msg] = await decryptGroupRows(gid, [{ ...data, seen_by: [] }]);
      list.push(msg);
    }
    g.last_msg = data.id;
    if (!mine) {
      setGroupTypingQuiet(g, data.from);
      if (state.openGroup === gid && document.visibilityState === "visible") {
        if (list) renderMessages();
        g.unread++;
        markGroupRead(gid);
      } else {
        g.unread++;
        if (state.openGroup === gid && list) renderMessages();
      }
    } else if (state.openGroup === gid) {
      renderMessages();
      scrollBottom();
    }
    renderBuddies();
    if (state.openGroup === gid) renderGroupHeader();
  } else if (data.type === "gtyping") {
    setGroupTyping(gid, data.from, data.state);
  } else if (data.type === "gseen") {
    const list = state.gmsgs.get(gid) || [];
    for (const m of list) if (m.from === state.me && m.id <= data.upto) m.seen.add(data.by);
    if (state.openGroup === gid) renderMessages();
  } else if (data.type === "gread-sync") {
    const g = state.groups.get(gid);
    if (g) {
      g.unread = 0;
      renderBuddies();
    }
  } else if (data.type === "group") {
    if (data.event === "removed") {
      const name = state.groups.has(gid) ? state.groups.get(gid).name : "that group";
      state.groups.delete(gid);
      state.gDetail.delete(gid);
      state.gmsgs.delete(gid);
      if (state.openGroup === gid) {
        closeGroupChat();
        toast("You're not in " + name + " any more");
      }
      if (groupPanel && groupPanel.id === gid) closeGroupPanel();
      renderBuddies();
    } else {
      await loadGroups();
      if (state.openGroup === gid) {
        await loadGroupDetail(gid);
        const g = state.groups.get(gid);
        if (g) g.canWrite = !!(await groupKey(gid, g.key_version));
        renderGroupHeader();
      }
      if (groupPanel && groupPanel.id === gid) await paintGroupPanel();
    }
  } else if (data.type === "gmsg-rejected") {
    toast(data.reason === "not_member" ? "You're not in that group any more." : "That message wasn't sent, the group key just changed. Try again.");
    if (data.reason === "bad_key" && state.groups.has(gid)) loadGroupDetail(gid).catch(() => {});
  }
}

// somebody who just wrote isn't typing any more
function setGroupTypingQuiet(g, user) {
  clearTimeout(g.typing.get(user));
  g.typing.delete(user);
}

// ---------- replacing the key after someone left ----------

const rekeying = new Set();

function maybeRekey(g) {
  if (!g.rekey_needed || rekeying.has(g.id)) return;
  rekeying.add(g.id);
  // the owner goes first; everyone else waits a moment so they don't all do it at once
  const wait = g.owner === state.me ? 0 : 500 + Math.random() * 2500;
  setTimeout(async () => {
    try {
      await rekeyGroup(g.id);
    } catch {
      // someone else got there first, or a member's key needs verifying: nothing to do here
    } finally {
      rekeying.delete(g.id);
    }
  }, wait);
}

async function rekeyGroup(gid) {
  const d = await loadGroupDetail(gid);
  if (!d.rekey_needed) return;
  const key = await generateGroupKey();
  const keys = await wrapForMembers(membersWithPubs(d), key);
  await gapi("/api/groups/" + gid + "/rekey", "POST", { version: d.key_version + 1, keys });
}

// ---------- making a group, adding people ----------

async function createGroup(name, usernames) {
  const members = [{ username: state.me, pub: state.myPub }];
  for (const u of usernames) {
    const c = state.contacts.get(u);
    members.push({ username: u, pub: c && !c.changed ? c.pub : null });
  }
  const key = await generateGroupKey();
  const keys = await wrapForMembers(members, key);
  const d = await gapi("/api/groups", "POST", { name, members: usernames, keys });
  await loadGroups();
  return d;
}

async function addToGroup(gid, username) {
  const d = await loadGroupDetail(gid);
  if (d.members.some((m) => m.username === username)) return;
  const c = state.contacts.get(username);
  const members = [...membersWithPubs(d), { username, pub: c && !c.changed ? c.pub : null }];
  // a brand new key, so the new person can only read from now on
  const key = await generateGroupKey();
  const keys = await wrapForMembers(members, key);
  await gapi("/api/groups/" + gid + "/members", "POST", { username, version: d.key_version + 1, keys });
}

async function leaveOrRemove(gid, username) {
  await gapi("/api/groups/" + gid + "/members/" + encodeURIComponent(username), "DELETE");
  await loadGroups();
}

// ---------- the panel ----------

let groupPanel = null; // { mode: "new" | "info", id }
let groupPanelReturnFocus = null;

function closeGroupPanel() {
  $("groups-overlay").hidden = true;
  groupPanel = null;
  if (groupPanelReturnFocus && document.contains(groupPanelReturnFocus)) groupPanelReturnFocus.focus();
  groupPanelReturnFocus = null;
}

async function openGroupPanel(mode, gid) {
  if ($("groups-overlay").hidden) groupPanelReturnFocus = document.activeElement;
  groupPanel = { mode, id: gid };
  $("groups-title").textContent = mode === "new" ? "New group" : "Group";
  $("groups-overlay").hidden = false;
  $("groups-close").focus();
  await paintGroupPanel();
}

async function paintGroupPanel() {
  if (!groupPanel) return;
  if (groupPanel.mode === "new") paintNewGroup();
  else await paintGroupInfo();
}

// a row with a checkbox: pick who to put in the group
function pickRow(c, picks, note) {
  const row = el("label", "list-row pick-row");
  const box = el("input");
  box.type = "checkbox";
  box.disabled = !!note;
  box.onchange = () => (box.checked ? picks.add(c.username) : picks.delete(c.username));
  const who = el("div", "who");
  who.append(el("b", "", shownName(c)), el("small", "", "@" + c.username + (note ? " - " + note : "")));
  row.append(box, avatarNode(c, "small"), who);
  return row;
}

function friendsToPick(exclude) {
  return [...state.contacts.values()].filter(
    (c) => c.friend === "friends" && !c.blocked && !exclude.has(c.username)
  );
}

function pickNote(c) {
  if (!c.pub) return "no key yet";
  if (c.changed) return "key changed";
  return "";
}

function paintNewGroup() {
  const body = $("groups-body");
  const picks = new Set();
  const name = el("input");
  name.type = "text";
  name.id = "group-name";
  name.maxLength = GROUP_NAME_MAX;
  name.placeholder = "group name";
  name.setAttribute("aria-label", "group name");
  const err = el("p");
  err.id = "groups-error";
  const friends = friendsToPick(new Set());
  const go = el("button", "", "Create group");
  go.type = "button";
  go.onclick = async () => {
    err.textContent = "";
    if (!name.value.trim()) {
      err.textContent = "give the group a name";
      return;
    }
    if (!picks.size) {
      err.textContent = "pick at least one friend";
      return;
    }
    go.disabled = true;
    try {
      const d = await createGroup(name.value.trim(), [...picks]);
      closeGroupPanel();
      openGroupChat(d.id);
    } catch (ex) {
      err.textContent = ex.message;
      go.disabled = false;
    }
  };
  body.replaceChildren(
    name,
    listSection("Pick friends", friends.map((c) => pickRow(c, picks, pickNote(c))), "You need to be friends with people before you can put them in a group."),
    el("p", "list-empty", "Messages are encrypted in your browser. Only the people in the group can read them."),
    go,
    err
  );
  name.focus();
}

async function paintGroupInfo() {
  const body = $("groups-body");
  const gid = groupPanel.id;
  let d;
  try {
    d = await loadGroupDetail(gid);
  } catch {
    body.replaceChildren(el("p", "list-empty", "couldn't load this group, close it and try again."));
    return;
  }
  $("groups-title").textContent = d.name;
  const err = el("p");
  err.id = "groups-error";
  const iOwn = d.owner === state.me;
  // run one action, then repaint so the panel matches the server
  const act = (fn) => async () => {
    err.textContent = "";
    try {
      await fn();
      await loadGroups();
      await paintGroupPanel();
    } catch (ex) {
      err.textContent = ex.message;
    }
  };

  const parts = [];

  if (iOwn) {
    const row = el("div", "rename-row");
    const input = el("input");
    input.type = "text";
    input.maxLength = GROUP_NAME_MAX;
    input.value = d.name;
    input.setAttribute("aria-label", "group name");
    row.append(
      input,
      listButton("Rename", act(() => gapi("/api/groups/" + gid, "PUT", { name: input.value })))
    );
    parts.push(row);
  }

  const memberRows = d.members.map((m) => {
    const tags = [m.owner ? "owner" : "", m.username === state.me ? "you" : ""].filter(Boolean).join(", ");
    const buttons = [];
    const changed = m.username !== state.me && m.pub && pubState(m.username, m.pub) === "changed";
    if (changed) {
      buttons.push(
        listButton("Trust new key", async () => {
          try {
            localStorage.setItem(knownSlot(m.username), m.pub);
          } catch {}
          await loadContacts().catch(() => {});
          await paintGroupPanel();
        })
      );
    }
    if (iOwn && m.username !== state.me) {
      buttons.push(
        listButton("Remove", () => {
          if (!confirm("Remove " + shownName(m) + " from the group? A new key is made so they can't read anything new.")) return;
          act(() => leaveOrRemove(gid, m.username))();
        })
      );
    }
    const row = personRow(m, tags, buttons);
    const who = row.querySelector(".who");
    if (changed) {
      const warn = el("small", "key-changed", "their key changed since you first saw it. Check it with them before trusting it.");
      who.append(warn);
    }
    if (m.pub) {
      const fp = el("small", "fp-line", "");
      fingerprintOf(m.pub).then((t) => (fp.textContent = "key " + t));
      who.append(fp);
    }
    return row;
  });
  parts.push(listSection("Members (" + d.members.length + ")", memberRows, ""));

  const inGroup = new Set(d.members.map((m) => m.username));
  const addable = friendsToPick(inGroup);
  if (addable.length) {
    const picks = new Set();
    const add = listButton("Add to group", act(async () => {
      if (!picks.size) throw new Error("pick someone to add");
      // one at a time: every new person means a new key
      for (const u of [...picks]) await addToGroup(gid, u);
    }));
    parts.push(listSection("Add friends", addable.map((c) => pickRow(c, picks, pickNote(c))), ""), add);
  }

  parts.push(
    el("p", "list-empty", "Messages are end-to-end encrypted. People you add can't read what was said before they joined, and people who leave can't read what comes after."),
    listButton("Leave group", () => {
      if (!confirm("Leave " + d.name + "?")) return;
      act(async () => {
        await leaveOrRemove(gid, state.me);
        closeGroupPanel();
      })();
    }),
    err
  );
  body.replaceChildren(...parts);
}

// ---------- wiring ----------

$("new-group").onclick = () => openGroupPanel("new");
$("group-info").onclick = () => state.openGroup != null && openGroupPanel("info", state.openGroup);
$("groups-close").onclick = closeGroupPanel;
$("groups-overlay").addEventListener("click", (e) => {
  if (e.target === $("groups-overlay")) closeGroupPanel();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("groups-overlay").hidden) closeGroupPanel();
});

// this file can finish loading after the socket connected
if (state.ws && state.ws.readyState === WebSocket.OPEN) loadGroups().catch(() => {});
