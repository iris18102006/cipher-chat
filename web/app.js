const $ = (id) => document.getElementById(id);
const PAGE = 50;

const state = {
  me: null,
  identity: null,
  myPub: null,
  contacts: new Map(), // username -> { username, pub, online, last_seen, unread, typing, changed }
  order: [], // usernames, most recent conversation first
  msgs: new Map(), // username -> [{ id, from, text, ts, delivered, read, failed }]
  hasOlder: new Map(),
  open: null,
  ws: null,
  retry: 0,
  keyCache: new Map(), // peer pub (base64) -> AES key
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
      pub: row.pub,
      online: row.online,
      last_seen: row.last_seen,
      unread: row.unread,
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
  for (const c of state.contacts.values()) n += c.unread;
  return n;
}

function renderBuddies() {
  const q = $("search").value.trim().toLowerCase();
  const ul = $("buddy-list");
  ul.replaceChildren();
  let shown = 0;
  for (const name of state.order) {
    if (q && !name.includes(q)) continue;
    const c = state.contacts.get(name);
    const li = el("li", name === state.open ? "active" : "");
    li.dataset.user = name;
    li.append(el("span", "dot " + (c.online ? "on" : "off")));
    const info = el("div", "buddy-info");
    info.append(el("div", "buddy-name", name));
    info.append(el("div", "buddy-sub", c.typing ? "typing..." : c.online ? "online" : lastSeenText(c)));
    li.append(info);
    if (c.unread > 0) li.append(el("span", "badge", c.unread > 99 ? "99+" : String(c.unread)));
    li.onclick = () => openChat(name);
    ul.append(li);
    shown++;
  }
  $("buddy-empty").hidden = shown > 0 || q !== "";
  const n = totalUnread();
  document.title = (n ? "(" + n + ") " : "") + "cipher-chat";
}

