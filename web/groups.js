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
