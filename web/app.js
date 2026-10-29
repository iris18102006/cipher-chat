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
      display_name: row.display_name,
      avatar: row.avatar,
      mood: row.mood,
      friend: row.friend, // none | friends | outgoing | incoming
      blocked: row.blocked,
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
  li.append(el("span", "buddy-avatar", avatarFor(c)));
  const info = el("div", "buddy-info");
  info.append(el("div", "buddy-name", shownName(c)));
  info.append(el("div", "buddy-sub", c.typing ? "typing..." : c.online ? "online" : lastSeenText(c)));
  if (c.mood) info.append(el("div", "buddy-mood", c.mood));
  li.append(info);
  if (c.unread > 0) li.append(el("span", "badge", c.unread > 99 ? "99+" : String(c.unread)));
  li.onclick = () => openChat(c.username);
  return li;
}

function renderBuddies() {
  const q = $("search").value.trim().toLowerCase();
  const ul = $("buddy-list");
  ul.replaceChildren();
  let shown = 0;
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
  const n = totalUnread();
  document.title = (n ? "(" + n + ") " : "") + "cipher-chat";
}

// ---------- chat pane ----------

function renderChatHeader() {
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
  $("typing").hidden = !c.typing;
  $("typing-name").textContent = c.typing ? c.username + " is typing" : "";
  const locked = !c.pub || c.changed;
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
  const list = state.msgs.get(state.open) || [];
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
    row.append(el("div", "text", m.text));
    const meta = el("div", "meta");
    meta.append(el("span", "time", clock(d)));
    if (mine) {
      const t = tickFor(m);
      meta.append(el("span", t.cls, t.text));
    }
    row.append(meta);
    box.append(row);
    prev = m;
  }
  $("older").hidden = !state.hasOlder.get(state.open);
  if (keepScroll) log.scrollTop = log.scrollHeight - before;
  else if (stick) scrollBottom();
}

async function decryptList(peer, rows) {
  const out = [];
  for (const r of rows) {
    const { text, failed } = await decryptFor(peer, r.iv, r.ct);
    out.push({ id: r.id, from: r.from, text, failed, ts: r.ts, delivered: r.delivered, read: r.read });
  }
  return out;
}

async function loadHistory(peer) {
  const rows = await api("/api/messages/" + encodeURIComponent(peer) + "?limit=" + PAGE);
  state.msgs.set(peer, await decryptList(peer, rows));
  state.hasOlder.set(peer, rows.length === PAGE);
}

async function loadOlder() {
  const peer = state.open;
  const list = state.msgs.get(peer) || [];
  if (!list.length) return;
  const rows = await api("/api/messages/" + encodeURIComponent(peer) + "?limit=" + PAGE + "&before=" + list[0].id);
  state.msgs.set(peer, [...(await decryptList(peer, rows)), ...list]);
  state.hasOlder.set(peer, rows.length === PAGE);
  renderMessages(true);
}

async function openChat(peer) {
  state.open = peer;
  document.body.classList.add("in-chat");
  $("chat-empty").hidden = true;
  $("chat-pane").hidden = false;
  $("verify-box").hidden = true;
  $("msg").value = "";
  autosize();
  renderChatHeader();
  renderBuddies();
  try {
    await loadHistory(peer);
  } catch {
    return;
  }
  if (state.open !== peer) return; // clicked someone else while loading
  renderMessages();
  scrollBottom();
  markRead(peer);
  if (!$("msg").disabled) $("msg").focus();
}

function markRead(peer) {
  const c = state.contacts.get(peer);
  if (!c) return;
  const hasUnread = c.unread > 0 || (state.msgs.get(peer) || []).some((m) => m.from === peer && !m.read);
  if (!hasUnread) return;
  c.unread = 0;
  for (const m of state.msgs.get(peer) || []) if (m.from === peer) m.read = true;
  sendWS({ type: "read", to: peer });
  renderBuddies();
}

// ---------- websocket ----------

function sendWS(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function setConn(ok, text) {
  const n = $("conn");
  n.textContent = text;
  n.className = "conn " + (ok ? "on" : "off");
}

function connect() {
  const proto = location.protocol === "https:" ? "wss://" : "ws://";
  const ws = new WebSocket(proto + location.host + "/ws");
  state.ws = ws;

  ws.onopen = async () => {
    state.retry = 0;
    setConn(true, "connected");
    try {
      await loadContacts();
      // catch up on anything we missed while disconnected
      if (state.open) {
        await loadHistory(state.open);
        renderMessages();
        markRead(state.open);
      }
    } catch {}
  };

  ws.onmessage = (e) => {
    let data;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }
    handleWS(data).catch(() => {});
  };

  ws.onclose = (e) => {
    if (e.code === 4401 || e.code === 4403) {
      location.href = "/login.html";
      return;
    }
    for (const c of state.contacts.values()) c.typing = false;
    setConn(false, "reconnecting...");
    const wait = Math.min(1000 * 2 ** state.retry, 10000);
    state.retry++;
    setTimeout(connect, wait);
  };
}

const typingTimers = new Map();

function setTyping(peer, on) {
  const c = state.contacts.get(peer);
  if (!c) return;
  c.typing = on;
  clearTimeout(typingTimers.get(peer));
  if (on) typingTimers.set(peer, setTimeout(() => setTyping(peer, false), 5000));
  renderBuddies();
  if (state.open === peer) {
    renderChatHeader();
    if (on && nearBottom()) scrollBottom();
  }
}

async function handleWS(data) {
  if (data.type === "presence") {
    const c = state.contacts.get(data.user);
    if (!c) return loadContacts();
    c.online = data.online;
    if (data.last_seen) c.last_seen = data.last_seen;
    if (!data.online) c.typing = false;
    renderBuddies();
    if (state.open === data.user) renderChatHeader();
  } else if (data.type === "typing") {
    setTyping(data.from, data.state);
  } else if (data.type === "msg") {
    const peer = data.from === state.me ? data.to : data.from;
    if (!state.contacts.has(peer)) await loadContacts();
    const c = state.contacts.get(peer);
    if (!c) return;
    const list = state.msgs.get(peer);
    const mine = data.from === state.me;
    if (list && !list.some((m) => m.id === data.id)) {
      const { text, failed } = await decryptFor(peer, data.iv, data.ct);
      list.push({ id: data.id, from: data.from, text, failed, ts: data.ts, delivered: !!data.delivered, read: false });
    }
    if (!mine) {
      c.typing = false;
      if (state.open === peer && document.visibilityState === "visible") {
        if (list) renderMessages();
        markRead(peer);
      } else {
        c.unread++;
        if (state.open === peer && list) renderMessages();
      }
    } else if (state.open === peer) {
      renderMessages();
      scrollBottom();
    }
    bump(peer);
    renderBuddies();
    if (state.open === peer) renderChatHeader();
  } else if (data.type === "receipt") {
    for (const list of state.msgs.values()) {
      const m = list.find((x) => x.id === data.id);
      if (m) m.delivered = true;
    }
    if (state.open) renderMessages();
  } else if (data.type === "read") {
    const list = state.msgs.get(data.by) || [];
    for (const m of list) if (data.ids.includes(m.id)) m.delivered = m.read = true;
    if (state.open === data.by) renderMessages();
  } else if (data.type === "read-sync") {
    const c = state.contacts.get(data.peer);
    if (c) {
      c.unread = 0;
      renderBuddies();
    }
  }
}

// ---------- composer ----------

let lastTypingSent = 0;
let typingStopTimer = null;

function notifyTyping() {
  const peer = state.open;
  if (!peer) return;
  const now = Date.now();
  if (now - lastTypingSent > 2500) {
    sendWS({ type: "typing", to: peer, state: true });
    lastTypingSent = now;
  }
  clearTimeout(typingStopTimer);
  typingStopTimer = setTimeout(() => {
    sendWS({ type: "typing", to: peer, state: false });
    lastTypingSent = 0;
  }, 3000);
}

function stopTyping() {
  clearTimeout(typingStopTimer);
  if (state.open && lastTypingSent) sendWS({ type: "typing", to: state.open, state: false });
  lastTypingSent = 0;
}

function autosize() {
  const t = $("msg");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 120) + "px";
}

async function sendMessage() {
  const peer = state.open;
  const text = $("msg").value.trim();
  if (!peer || !text) return;
  const c = state.contacts.get(peer);
  if (!c || !c.pub || c.changed) return;
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    setConn(false, "offline, message not sent");
    return;
  }
  const key = await sharedKeyFor(peer);
  const { iv, ct } = await encryptText(key, text);
  if (sendWS({ type: "msg", to: peer, iv, ct, cid: crypto.randomUUID() })) {
    $("msg").value = "";
    autosize();
    stopTyping();
  }
}

// ---------- wiring ----------

$("composer").onsubmit = (e) => {
  e.preventDefault();
  sendMessage();
};

$("msg").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});
$("msg").addEventListener("input", () => {
  autosize();
  notifyTyping();
});

$("search").addEventListener("input", renderBuddies);
$("older").onclick = loadOlder;

$("back").onclick = () => {
  stopTyping();
  document.body.classList.remove("in-chat");
  state.open = null;
  $("chat-pane").hidden = true;
  $("chat-empty").hidden = false;
  renderBuddies();
};

$("verify").onclick = async () => {
  const box = $("verify-box");
  box.hidden = !box.hidden;
  if (!box.hidden) await renderVerify();
};

$("trust").onclick = async () => {
  const c = state.contacts.get(state.open);
  if (!c || !c.pub) return;
  try {
    localStorage.setItem(knownSlot(c.username), c.pub);
  } catch {}
  c.changed = false;
  await loadHistory(c.username);
  renderChatHeader();
  renderMessages();
};

$("logout").onclick = async () => {
  try {
    await fetch("/api/logout", { method: "POST" });
  } catch {}
  location.href = "/login.html";
};

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.open) markRead(state.open);
});
window.addEventListener("focus", () => {
  if (state.open) markRead(state.open);
});

// keepalive so idle proxies don't drop the socket
setInterval(() => sendWS({ type: "ping" }), 25000);
// pick up new signups and fresh last-seen times
setInterval(() => {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) loadContacts().catch(() => {});
}, 30000);

(async function boot() {
  try {
    const me = await api("/api/me");
    state.me = me.username;
    $("me-name").textContent = me.username;
    state.identity = await loadOrCreateIdentity(me.username);
    state.myPub = await exportPub(state.identity.publicKey);
    // publish our public key so friends can derive the shared secret
    await api("/api/key", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pub: state.myPub }),
    });
    $("my-key").textContent = "your key: " + (await fingerprintOf(state.myPub));
    connect();
  } catch (err) {
    if (state.me) setConn(false, "couldn't start, check the console");
    console.error(err);
  }
})();
