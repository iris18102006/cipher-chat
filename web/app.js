const $ = (id) => document.getElementById(id);
const PAGE = 50;

const state = {
  me: null,
  identity: null,
  myPub: null,
  contacts: new Map(), // username -> { username, display_name, avatar, mood, friend, blocked, pub, online, last_seen, unread, typing, changed }
  order: [], // usernames, most recent conversation first
  msgs: new Map(), // username -> [{ id, from, text, ts, delivered, read, failed }]
  hasOlder: new Map(),
  open: null,
  ws: null,
  retry: 0,
  keyCache: new Map(), // peer pub (base64) -> AES key
  // group chats (groups.js)
  groups: new Map(), // id -> { id, name, owner, members, key_version, rekey_needed, unread, last_msg, typing, canWrite }
  openGroup: null, // id of the group chat that's open, or null (state.open is null while it is)
  gmsgs: new Map(), // id -> [{ id, from, text, ts, failed, seen }]
  gHasOlder: new Map(),
  gDetail: new Map(), // id -> members + my wrapped keys, as the server sent them
  gKeys: new Map(), // "id:version" -> unwrapped group AES key
};

// ---------- small helpers ----------

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (res.status === 401) {
    location.href = "/login.html";
    throw new Error("not logged in");
  }
  if (!res.ok) throw new Error("request failed: " + res.status);
  return res.json();
}

function parseTs(ts) {
  // sqlite gives "YYYY-MM-DD HH:MM:SS" in UTC
  return new Date(ts.replace(" ", "T") + "Z");
}

function clock(d) {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(d) {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

function lastSeenText(c) {
  if (c.online) return "online";
  if (!c.last_seen) return "offline";
  const d = parseTs(c.last_seen);
  const day = dayLabel(d);
  return "last seen " + (day === "Today" ? "today" : day.toLowerCase()) + " at " + clock(d);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

// small popup in the corner, goes away by itself
let toastTimer = null;

function toast(text, onClick) {
  const t = $("toast");
  t.textContent = text;
  t.onclick = () => {
    t.hidden = true;
    if (onClick) onClick();
  };
  t.style.cursor = onClick ? "pointer" : "default";
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 6000);
}

// ---------- keys ----------

async function sharedKeyFor(peer) {
  const c = state.contacts.get(peer);
  if (!c || !c.pub) return null;
  let key = state.keyCache.get(c.pub);
  if (!key) {
    key = await deriveSharedKey(state.identity.privateKey, await importPub(c.pub));
    state.keyCache.set(c.pub, key);
  }
  return key;
}

// trust on first use: remember the first key we saw for each friend and
// shout if it ever changes (could be a new device, could be someone in the middle)
function knownSlot(peer) {
  return "cc-known:" + state.me + ":" + peer;
}

function checkKeyTrust(c) {
  if (!c.pub) {
    c.changed = false;
    return;
  }
  let known = null;
  try {
    known = localStorage.getItem(knownSlot(c.username));
  } catch {}
  if (!known) {
    try {
      localStorage.setItem(knownSlot(c.username), c.pub);
    } catch {}
    c.changed = false;
  } else {
    c.changed = known !== c.pub;
  }
}

async function decryptFor(peer, iv, ct) {
  try {
    const key = await sharedKeyFor(peer);
    if (!key) throw new Error("no key");
    return { text: await decryptText(key, iv, ct), failed: false };
  } catch {
    return { text: "can't decrypt this message (the key changed or it's corrupted)", failed: true };
  }
}

// ---------- contacts ----------

async function loadContacts() {
  const list = await api("/api/contacts");
  const prev = state.contacts;
  state.contacts = new Map();
  state.order = [];
  for (const row of list) {
    const old = prev.get(row.username);
    const c = {
      username: row.username,
      display_name: row.display_name,
      avatar: row.avatar,
      mood: row.mood,
      friend: row.friend, // none | friends | outgoing | incoming
      blocked: row.blocked,
      pub: row.pub,
      online: row.online,
      last_seen: row.last_seen,
      unread: row.unread,
      held: row.held || 0, // messages from a friend request that wait for me to accept
      typing: old ? old.typing : false,
      changed: false,
    };
    checkKeyTrust(c);
    state.contacts.set(c.username, c);
    state.order.push(c.username);
  }
  renderBuddies();
  if (state.open) renderChatHeader();
}

function bump(username) {
  state.order = [username, ...state.order.filter((u) => u !== username)];
}

function totalUnread() {
  let n = 0;
  for (const c of state.contacts.values()) n += c.unread + c.held;
  if (typeof totalGroupUnread === "function") n += totalGroupUnread();
  return n;
}

// buddy list sections, in the order they're shown
const BUDDY_GROUPS = [
  ["requests", "Friend requests"],
  ["friends", "Friends"],
  ["people", "People"],
  ["blocked", "Blocked"],
];

function groupOf(c) {
  if (c.blocked) return "blocked";
  if (c.friend === "incoming") return "requests";
  if (c.friend === "friends") return "friends";
  return "people";
}

function buddyRow(c) {
  const li = el("li", c.username === state.open ? "active" : "");
  li.dataset.user = c.username;
  li.append(el("span", "dot " + (c.online ? "on" : "off")));
  li.append(avatarNode(c, "tiny"));
  const info = el("div", "buddy-info");
  info.append(el("div", "buddy-name", shownName(c)));
  info.append(el("div", "buddy-sub", c.typing ? "typing..." : c.online ? "online" : lastSeenText(c)));
  if (c.mood) info.append(el("div", "buddy-mood", c.mood));
  li.append(info);
  if (c.unread > 0) li.append(el("span", "badge", c.unread > 99 ? "99+" : String(c.unread)));
  else if (c.held > 0) {
    const w = el("span", "badge held", String(c.held));
    w.title = c.held + " message(s) waiting until you accept the request";
    li.append(w);
  }
  li.onclick = () => openChat(c.username);
  return li;
}

function renderBuddies() {
  const q = $("search").value.trim().toLowerCase();
  const ul = $("buddy-list");
  ul.replaceChildren();
  let shown = 0;
  // group chats come first
  if (typeof groupSection === "function") {
    const g = groupSection(q);
    ul.append(...g.nodes);
    shown += g.count;
  }
  for (const [key, title] of BUDDY_GROUPS) {
    const rows = state.order
      .map((name) => state.contacts.get(name))
      .filter((c) => groupOf(c) === key)
      .filter((c) => !q || c.username.includes(q) || shownName(c).toLowerCase().includes(q));
    if (!rows.length) continue;
    ul.append(el("li", "group " + key, title + " (" + rows.length + ")"));
    for (const c of rows) ul.append(buddyRow(c));
    shown += rows.length;
  }
  $("buddy-empty").hidden = shown > 0 || q !== "";
  // number of friend requests waiting for me, on the Requests button
  let waiting = 0;
  for (const c of state.contacts.values()) if (c.friend === "incoming" && !c.blocked) waiting++;
  $("req-count").textContent = String(waiting);
  $("req-count").hidden = waiting === 0;
  const n = totalUnread();
  document.title = (n ? "(" + n + ") " : "") + "cipher-chat";
}

// ---------- chat pane ----------

function renderChatHeader() {
  if (state.openGroup != null) return renderGroupHeader();
  // back from a group chat: the 1:1 buttons come back, the group one goes
  $("group-info").hidden = true;
  for (const id of ["view-profile", "verify", "block"]) $(id).hidden = false;
  $("msg").placeholder = "type a message (Enter to send, Shift+Enter for a new line)";
  const c = state.contacts.get(state.open);
  if (!c) return;
  $("chat-name").textContent = shownName(c);
  $("chat-name").title = "@" + c.username;
  const status = c.typing ? "typing..." : lastSeenText(c);
  $("chat-status").textContent = status;
  $("chat-status").className = c.online ? "online" : "";

  const warn = $("key-warning");
  if (!c.pub) {
    warn.hidden = false;
    $("key-warning-text").textContent =
      c.username + " hasn't opened cipher-chat since encryption was set up, so there's no key yet. You can message them once they log in.";
    $("trust").hidden = true;
  } else if (c.changed) {
    warn.hidden = false;
    $("key-warning-text").textContent =
      "Heads up: " + c.username + "'s encryption key changed. It could be a new device, or someone tampering. Check the key with them before trusting it.";
    $("trust").hidden = false;
  } else {
    warn.hidden = true;
  }
  $("block-banner").hidden = !c.blocked;
  if (c.blocked) {
    $("block-banner-text").textContent =
      "You blocked " + shownName(c) + ". They can't message you and they can't see when you're online.";
  }
  // a friend request that's waiting on someone: say so, and let the person answer it right here
  const banner = $("request-banner");
  banner.hidden = c.blocked || (c.friend !== "incoming" && c.friend !== "outgoing");
  if (!banner.hidden) {
    const incoming = c.friend === "incoming";
    $("req-accept").hidden = $("req-decline").hidden = !incoming;
    $("request-banner-text").textContent = incoming
      ? shownName(c) + " sent you a friend request." +
        (c.held > 0 ? " They wrote " + c.held + " message" + (c.held > 1 ? "s" : "") + ", accept the request to read " + (c.held > 1 ? "them" : "it") + "." : "")
      : "Waiting for " + shownName(c) + " to accept your friend request.";
  }
  $("block").textContent = c.blocked ? "Unblock" : "Block";
  $("typing").hidden = !c.typing;
  $("typing-name").textContent = c.typing ? c.username + " is typing" : "";
  const locked = !c.pub || c.changed || c.blocked;
  $("msg").disabled = locked;
  $("send").disabled = locked;
}

async function renderVerify() {
  const c = state.contacts.get(state.open);
  const box = $("verify-box");
  box.replaceChildren();
  box.append(el("p", "", "Compare these with " + c.username + " on a call or in person. If they match, nobody is sitting in the middle."));
  const mine = el("div", "fp");
  mine.append(el("b", "", "your key: "), el("code", "", await fingerprintOf(state.myPub)));
  box.append(mine);
  if (c.pub) {
    const theirs = el("div", "fp");
    theirs.append(el("b", "", c.username + "'s key: "), el("code", "", await fingerprintOf(c.pub)));
    box.append(theirs);
  }
}

function nearBottom() {
  const log = $("log");
  return log.scrollHeight - log.scrollTop - log.clientHeight < 80;
}

function scrollBottom() {
  const log = $("log");
  log.scrollTop = log.scrollHeight;
}

function tickFor(m) {
  if (m.held) return { text: "\u2713 sent, waiting for them to accept", cls: "tick" };
  if (m.read) return { text: "\u2713\u2713 read", cls: "tick read" };
  if (m.delivered) return { text: "\u2713\u2713 delivered", cls: "tick" };
  return { text: "\u2713 sent", cls: "tick" };
}

function renderMessages(keepScroll) {
  const box = $("messages");
  const log = $("log");
  const stick = !keepScroll && nearBottom();
  const before = log.scrollHeight - log.scrollTop;
  box.replaceChildren();
  const inGroup = state.openGroup != null;
  const list = (inGroup ? state.gmsgs.get(state.openGroup) : state.msgs.get(state.open)) || [];
  let lastDay = "";
  let prev = null;
  for (const m of list) {
    const d = parseTs(m.ts);
    const label = dayLabel(d);
    if (label !== lastDay) {
      box.append(el("div", "day", label));
      lastDay = label;
      prev = null;
    }
    const mine = m.from === state.me;
    const row = el("div", "msg " + (mine ? "me" : "them") + (m.failed ? " failed" : "") + (prev && prev.from === m.from ? " cont" : ""));
    // in a group, say who wrote it (once per run of messages from the same person)
    if (inGroup && !mine && !(prev && prev.from === m.from)) {
      row.append(el("div", "sender", memberName(state.openGroup, m.from)));
    }
    row.append(el("div", "text", m.text));
    const meta = el("div", "meta");
    meta.append(el("span", "time", clock(d)));
    if (mine) {
      const t = inGroup ? groupTick(m) : tickFor(m);
      const tick = el("span", t.cls, t.text);
      if (t.title) tick.title = t.title;
      meta.append(tick);
    }
    row.append(meta);
    box.append(row);
    prev = m;
  }
  $("older").hidden = !(inGroup ? state.gHasOlder.get(state.openGroup) : state.hasOlder.get(state.open));
  if (keepScroll) log.scrollTop = log.scrollHeight - before;
  else if (stick) scrollBottom();
}
