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
