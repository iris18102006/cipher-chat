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
  if (!res.ok) {
    let detail = "";
    try {
      const data = await res.json();
      if (data && typeof data.detail === "string") detail = data.detail;
    } catch {}
    const err = new Error(detail || "request failed: " + res.status);
    err.status = res.status;
    err.server = !!detail; // the message is the server's own reason, fine to show
    throw err;
  }
  return res.json();
}

// the server's reason if it gave one, otherwise a plain fallback
function whyFailed(ex, fallback) {
  return ex && ex.server ? ex.message : fallback;
}

// why the server can refuse a message, shown as a popup
const REJECT_REASONS = {
  wait: "They want you to wait until they accept your friend request.",
  limit: "You can only leave a few messages until they accept your request.",
  not_friends: "You're not friends with them any more, so that message wasn't sent.",
  too_long: "That message is too long, split it into a few shorter ones.",
};

// the longest text one message can hold: the ciphertext (base64) has to stay under 16,000 characters
const MAX_MSG_BYTES = 11900;
function tooLong(text) {
  if (new TextEncoder().encode(text).length <= MAX_MSG_BYTES) return false;
  toast("That message is too long, split it into a few shorter ones.");
  return true;
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

// ---------- forward secrecy: keeping the server stocked with one-time prekeys ----------

let topUpBusy = false;

// Friends use up one of our public prekeys for every message they send us. When the
// server is running low, make more here (the private halves stay in this browser) and
// upload the public halves.
async function topUpPrekeys() {
  if (!state.me || topUpBusy) return;
  topUpBusy = true;
  try {
    const { count } = await api("/api/prekeys");
    if (count >= PREKEY_LOW) return;
    const keys = await makePrekeys(state.me, PREKEY_TARGET - count);
    await api("/api/prekeys", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys }),
    });
  } catch (err) {
    console.error("couldn't top up prekeys", err);
  } finally {
    topUpBusy = false;
  }
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

// What to show when a forward secret message can't be opened. The key for each one exists
// once, so these aren't errors in the usual sense: it's what forward secrecy looks like.
const GONE_TEXT = "can't open this message here (its one-time key is gone, it was read on another browser or this browser's data was cleared)";
const OTHER_BROWSER_TEXT = "you sent this from another browser, it can't be opened here";

// Opens one message from a history row or a live websocket message ({ id, from, v, eph,
// pid, cid, iv, ct }). Order: text we already kept on this device, then old style (one
// long-term key, can be opened any time), then forward secret (needs the one-time key).
async function decryptMessage(peer, m) {
  const mine = m.from === state.me;
  try {
    const kept = await loadPlain(state.me, m.id);
    if (kept !== null) return { text: kept, failed: false };
    if (mine && m.cid) {
      // we sent it and the server has just told us its id: move our copy over to it
      const pending = await loadPending(state.me, m.cid);
      if (pending !== null) {
        await savePlain(state.me, m.id, pending);
        await dropPending(state.me, m.cid);
        return { text: pending, failed: false };
      }
    }
  } catch {}
  if (m.v !== 2) return decryptFor(peer, m.iv, m.ct);
  if (mine) return { text: OTHER_BROWSER_TEXT, failed: true };
  try {
    const c = state.contacts.get(peer);
    if (!c || !c.pub) throw new Error("no key");
    const prekey = await loadPrekey(state.me, m.pid);
    if (!prekey) {
      // another tab may have opened it a moment ago, it saves the text before deleting the key
      const again = await loadPlain(state.me, m.id);
      return again !== null ? { text: again, failed: false } : { text: GONE_TEXT, failed: true };
    }
    const text = await openForwardSecret(state.identity.privateKey, await importPub(c.pub), prekey, m.eph, m.iv, m.ct);
    // save the text first, and only then let the key go
    await savePlain(state.me, m.id, text);
    await deletePrekey(state.me, m.pid);
    return { text, failed: false };
  } catch {
    return { text: "can't decrypt this message (the key changed or it's corrupted)", failed: true };
  }
}

// ---------- contacts ----------

async function loadContacts() {
  const list = await api("/api/contacts");
  const prev = state.contacts;
  const heldBefore = state.open && prev.get(state.open) ? prev.get(state.open).held : 0;
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
  // the request was accepted (here, from a profile, or from the list) or the setting changed:
  // the messages that were waiting are readable now, so load them into the open chat
  const open = state.open;
  const now = open && state.contacts.get(open);
  if (heldBefore > 0 && now && now.held === 0) {
    try {
      await loadHistory(open);
      if (state.open === open) {
        renderMessages();
        scrollBottom();
        markRead(open);
      }
    } catch {}
  }
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
  // Old messages were all sent the old way, that's not worth a label on every one. But once
  // a chat has started using one-time keys, a message after that without one is a fallback
  // (they'd run out of keys), and that is worth knowing.
  const firstFS = inGroup ? null : list.find((x) => x.v === 2);
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
    if (firstFS && m.v !== 2 && m.id > firstFS.id) {
      const nofs = el("span", "nofs", "no forward secrecy");
      nofs.title = "This message was locked with the long-term key only, because there were no one-time keys left";
      meta.append(nofs);
    }
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

async function decryptList(peer, rows) {
  const out = [];
  for (const r of rows) {
    const { text, failed } = await decryptMessage(peer, r);
    out.push({ id: r.id, from: r.from, v: r.v, text, failed, ts: r.ts, delivered: r.delivered, read: r.read, held: !!r.held });
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
  stopTyping(); // tell whoever we were typing to that we stopped
  state.openGroup = null;
  state.open = peer;
  if (typeof applyChatTheme === "function") applyChatTheme();
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
      if (typeof loadGroups === "function") await loadGroups();
      if (typeof loadChatThemes === "function") await loadChatThemes();
      // catch up on anything we missed while disconnected
      if (state.open) {
        await loadHistory(state.open);
        renderMessages();
        markRead(state.open);
      } else if (state.openGroup != null && state.groups.has(state.openGroup)) {
        await loadGroupHistory(state.openGroup);
        renderGroupHeader();
        renderMessages();
        markGroupRead(state.openGroup);
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
    for (const g of state.groups.values()) g.typing.clear();
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
  if (typeof GROUP_EVENTS !== "undefined" && GROUP_EVENTS.includes(data.type)) {
    return handleGroupWS(data);
  }
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
    const fresh = !state.contacts.has(peer);
    if (fresh) await loadContacts();
    const c = state.contacts.get(peer);
    if (!c) return;
    const list = state.msgs.get(peer);
    const mine = data.from === state.me;
    if (list && !list.some((m) => m.id === data.id)) {
      const { text, failed } = await decryptMessage(peer, data);
      list.push({ id: data.id, from: data.from, v: data.v, text, failed, ts: data.ts, delivered: !!data.delivered, read: false, held: !!data.held });
    }
    if (!mine) {
      c.typing = false;
      if (state.open === peer && document.visibilityState === "visible") {
        if (list) renderMessages();
        markRead(peer);
      } else {
        if (!fresh) c.unread++; // a freshly loaded list already counts this message
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
      if (m) {
        m.delivered = true;
        m.held = false;
      }
    }
    if (state.open) renderMessages();
  } else if (data.type === "read") {
    const list = state.msgs.get(data.by) || [];
    for (const m of list) if (data.ids.includes(m.id)) m.delivered = m.read = true;
    if (state.open === data.by) renderMessages();
  } else if (data.type === "social") {
    // friend request / accepted / removed / block changed: reload the lists
    await loadContacts();
    const from = state.contacts.get(data.from);
    const who = from ? shownName(from) : data.from;
    if (data.event === "request") {
      toast(who + " sent you a friend request", () => openProfile(data.from));
    } else if (data.event === "accepted") {
      toast(who + " accepted your friend request", () => openProfile(data.from));
    }
    if (typeof refreshLists === "function") refreshLists();
    // keep a profile that's open on that person up to date
    if (typeof pfCurrent !== "undefined" && pfCurrent && pfCurrent.username === data.from) {
      openProfile(data.from);
    }
  } else if (data.type === "msg-rejected") {
    toast(REJECT_REASONS[data.reason] || "That message wasn't sent.");
    // the copy of the text we kept for it is no use now
    if (data.cid) dropPending(state.me, data.cid).catch(() => {});
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

// the typing message for whatever is open: a friend, or a group
function typingFrame(on) {
  if (state.openGroup != null) return { type: "gtyping", group: state.openGroup, state: on };
  if (state.open) return { type: "typing", to: state.open, state: on };
  return null;
}

function notifyTyping() {
  if (!typingFrame(true)) return;
  const now = Date.now();
  if (now - lastTypingSent > 2500) {
    sendWS(typingFrame(true));
    lastTypingSent = now;
  }
  clearTimeout(typingStopTimer);
  // aimed at the chat it was typed in, even if you switch chats before it fires
  const off = typingFrame(false);
  typingStopTimer = setTimeout(() => {
    sendWS(off);
    lastTypingSent = 0;
  }, 3000);
}

function stopTyping() {
  clearTimeout(typingStopTimer);
  const frame = typingFrame(false);
  if (frame && lastTypingSent) sendWS(frame);
  lastTypingSent = 0;
}

function autosize() {
  const t = $("msg");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 120) + "px";
}

async function sendMessage() {
  if (state.openGroup != null) return sendGroupMessage();
  const peer = state.open;
  const text = $("msg").value.trim();
  if (!peer || !text) return;
  const c = state.contacts.get(peer);
  if (!c || !c.pub || c.changed) return;
  if (tooLong(text)) return;
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    setConn(false, "offline, message not sent");
    return;
  }
  // Each message takes one of their one-time prekeys. The server hands it out once and
  // deletes it, so no two messages ever share one.
  let claim;
  try {
    claim = await api("/api/prekeys/claim/" + encodeURIComponent(peer), { method: "POST" });
  } catch (ex) {
    toast(whyFailed(ex, "Couldn't send that, try again."));
    return;
  }
  if (claim.refused) {
    toast(REJECT_REASONS[claim.refused] || "That message wasn't sent.");
    return;
  }
  const cid = crypto.randomUUID();
  let body;
  if (claim.pub) {
    const sealed = await sealForwardSecret(state.identity.privateKey, await importPub(c.pub), claim.pub, text);
    body = { iv: sealed.iv, ct: sealed.ct, eph: sealed.eph, pid: claim.id };
    // nobody can open this one again, us included, so keep the text until the server
    // tells us the message's id (decryptMessage moves it over)
    await savePending(state.me, cid, text);
  } else {
    // they've run out of one-time keys (they'll make more next time they're online).
    // Better to send the old way than not at all, but say so
    const key = await sharedKeyFor(peer);
    body = await encryptText(key, text);
    toast("Sent without forward secrecy: they're out of one-time keys. It will be fixed when they're back online.");
  }
  if (sendWS({ type: "msg", to: peer, cid, ...body })) {
    $("msg").value = "";
    autosize();
    stopTyping();
  } else {
    dropPending(state.me, cid).catch(() => {});
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
$("add-user-form").onsubmit = async (e) => {
  e.preventDefault();
  const username = $("add-username").value.trim().toLowerCase();
  const err = $("add-user-error");
  err.hidden = true;
  err.textContent = "";
  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    err.textContent = "enter an exact username";
    err.hidden = false;
    return;
  }
  try {
    await openProfile(username);
    if (!pfCurrent) throw new Error();
    $("add-username").value = "";
  } catch {
    err.textContent = "user not found";
    err.hidden = false;
  }
};
$("older").onclick = () => (state.openGroup != null ? loadOlderGroup() : loadOlder());

$("back").onclick = () => {
  stopTyping();
  document.body.classList.remove("in-chat");
  state.open = null;
  state.openGroup = null;
  $("group-info").hidden = true;
  $("chat-pane").hidden = true;
  $("chat-empty").hidden = false;
  renderBuddies();
};

// answer a friend request from the chat itself
$("req-accept").onclick = async () => {
  const peer = state.open;
  if (!peer) return;
  try {
    await api("/api/friends/" + encodeURIComponent(peer) + "/accept", { method: "POST" });
    await loadContacts();
    if (state.open !== peer) return;
    await loadHistory(peer); // messages that were waiting are there now
    renderMessages();
    scrollBottom();
    markRead(peer);
  } catch {
    toast("couldn't accept that, try again");
  }
};
$("req-decline").onclick = async () => {
  const peer = state.open;
  if (!peer) return;
  try {
    await api("/api/friends/" + encodeURIComponent(peer), { method: "DELETE" });
    await loadContacts();
    $("back").onclick();
  } catch {
    toast("couldn't decline that, try again");
  }
};

$("verify").onclick = async () => {
  const box = $("verify-box");
  box.hidden = !box.hidden;
  if (!box.hidden) await renderVerify();
};

async function setBlocked(username, on) {
  const c = state.contacts.get(username);
  if (!c) return;
  if (on && !confirm("Block " + shownName(c) + "? They won't be able to message you or see when you're online, and you'll stop being friends.")) {
    return;
  }
  try {
    await api("/api/blocks/" + encodeURIComponent(username), { method: on ? "POST" : "DELETE" });
    await loadContacts();
    if (!on) {
      // blocking ended the friendship, so after unblocking they're not in the buddy list any
      // more. Close the chat that's still showing "you blocked them" and say what happened.
      if (state.open === username && !state.contacts.has(username)) $("back").onclick();
      toast("Unblocked " + shownName(c) + ". You're not friends any more, send a new request from their profile.", () => openProfile(username));
    }
    if (typeof refreshLists === "function") refreshLists();
  } catch {
    toast("couldn't change the block, try again");
  }
}

$("block").onclick = () => {
  const c = state.contacts.get(state.open);
  if (c) setBlocked(c.username, !c.blocked);
};
$("unblock").onclick = () => state.open && setBlocked(state.open, false);

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

function markOpenRead() {
  if (state.open) markRead(state.open);
  else if (state.openGroup != null) markGroupRead(state.openGroup);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") markOpenRead();
});
window.addEventListener("focus", markOpenRead);

// keepalive so idle proxies don't drop the socket
setInterval(() => sendWS({ type: "ping" }), 25000);
// friends keep using up our one-time prekeys, so check now and then that there are enough
setInterval(topUpPrekeys, 2 * 60 * 1000);
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
    // the key is uploaded, so any prekeys belonging to an older key are gone: stock up
    await topUpPrekeys();
    connect();
  } catch (err) {
    if (state.me) setConn(false, "couldn't start, check the console");
    console.error(err);
  }
})();
