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

// Same idea for the signing key: the first one we see for a person is the one we trust.
// A different one later is shown as a warning on their messages, never trusted quietly.
const signSlot = (username) => "cc-known-sign:" + state.me + ":" + username;

function signPubState(username, pub) {
  if (username === state.me) return "ok";
  const slot = signSlot(username);
  let known = null;
  try {
    known = localStorage.getItem(slot);
  } catch {}
  if (!known) {
    try {
      localStorage.setItem(slot, pub);
    } catch {}
    return "ok";
  }
  return known === pub ? "ok" : "changed";
}

// Who really wrote this? One of:
//   ok        signed with the sender's signing key
//   unsigned  no signature (sent before signing existed, or by an old browser)
//   unknown   signed, but the sender isn't in the group any more so there's no key to check
//   changed   signed, but the sender's signing key isn't the one we first saw
//   bad       the signature doesn't match this message and sender: it was not made by them
async function checkSignature(gid, r) {
  if (!r.sig) return "unsigned";
  const d = state.gDetail.get(gid);
  const member = d && d.members.find((x) => x.username === r.from);
  const pub = r.from === state.me ? state.mySignPub : member && member.sign_pub;
  if (!pub) return "unknown";
  if (signPubState(r.from, pub) === "changed") return "changed";
  const good = await verifyGroupMessage(pub, r.sig, gid, r.v, r.from, r.iv, r.ct, r.n);
  return good ? "ok" : "bad";
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

// ---------- forward secrecy: turning group keys into key chains ----------
// From fs_version on, a group key is only used to start everybody's key chain (see crypto.js).
// As soon as this device has saved those chains it asks the server to destroy its wrapped copy
// of the key, so the key itself no longer exists anywhere that can be stolen from. After that
// each message is opened with a one-use key that is deleted as it's used.

const isForwardSecret = (d, version) => version >= d.fs_version;
const chainSetups = new Map(); // gid -> the setup that's running, so it isn't done twice at once

// Set up chains for every forward-secret key version I still hold a wrapped copy of.
function ensureChains(gid) {
  if (chainSetups.has(gid)) return chainSetups.get(gid);
  const job = (async () => {
    const d = state.gDetail.get(gid);
    if (!d) return;
    for (const w of d.keys.filter((k) => isForwardSecret(d, k.version))) {
      try {
        // the wrapper's key has to be the one we first saw, same rule as for any group key
        if (pubState(w.from, w.from_pub) === "changed") continue;
        const wrapKey = await deriveSharedKey(state.identity.privateKey, await importPub(w.from_pub), GROUP_WRAP_INFO);
        const seed = await unwrapGroupSeed(wrapKey, w.iv, w.wk);
        const names = new Set(d.members.map((m) => m.username));
        for (const s of d.senders || []) if (s.v === w.version) names.add(s.u);
        // saved first. Only when this has finished is it safe to destroy the server's copy
        await adoptGroupVersion(state.me, gid, w.version, seed, [...names]);
        await gapi("/api/groups/" + gid + "/keys/" + w.version + "/ack", "POST");
        d.keys = d.keys.filter((k) => k.version !== w.version);
      } catch {
        // couldn't unwrap it or reach the server: the wrapped copy stays and we try again next time
      }
    }
  })().finally(() => chainSetups.delete(gid));
  chainSetups.set(gid, job);
  return job;
}

// Can I write to this group right now?
async function canWriteGroup(gid) {
  const d = state.gDetail.get(gid);
  if (!d) return false;
  if (isForwardSecret(d, d.key_version)) return !!(await loadChain(state.me, gid, d.key_version, state.me));
  return !!(await groupKey(gid, d.key_version));
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
  await ensureChains(gid);
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

const NO_KEY_TEXT = "can't decrypt this message (missing key, or the sender's key changed)";
const USED_KEY_TEXT = "can't open this message again: its one-use key was deleted and this device didn't keep a copy of the text";
const FAKE_TEXT = "\u26a0 this message failed its signature check, so it was not opened";

// Open one message that has a chain number (forward secret). Returns { text, failed }.
async function openChainRow(gid, r, signed) {
  // 1. already opened on this device: the text was kept, the key is long gone
  const kept = await loadGroupPlain(state.me, gid, r.id);
  if (kept !== null) return { text: kept, failed: false };
  // 2. something I sent: the text was saved when I sent it, under its client id (live echo)
  //    and under its key version and number (history, if the echo never got here)
  if (r.from === state.me) {
    const sent =
      (r.cid ? await loadGroupPending(state.me, gid, r.cid) : null) ?? (await loadGroupSent(state.me, gid, r.v, r.n));
    if (sent !== null) {
      await saveGroupPlain(state.me, gid, r.id, sent);
      if (r.cid) await dropGroupPending(state.me, gid, r.cid);
      await dropGroupSent(state.me, gid, r.v, r.n);
      return { text: sent, failed: false };
    }
  }
  // 3. a message that isn't from who it says must not be opened: opening moves the chain on,
  //    and a fake must not be able to push it forward
  if (signed === "bad" || signed === "changed") return { text: FAKE_TEXT, failed: true };
  try {
    const out = await withChain(state.me, gid, r.v, r.from, async (chain) => {
      if (!chain) throw new Error("no chain");
      const opened = await chainOpen(chain, r.n, r.iv, r.ct);
      return { state: opened.state, text: opened.text };
    });
    await saveGroupPlain(state.me, gid, r.id, out.text);
    return { text: out.text, failed: false };
  } catch (ex) {
    const noChain = ex && ex.message === "no chain";
    return { text: noChain ? NO_KEY_TEXT : USED_KEY_TEXT, failed: true };
  }
}

async function decryptGroupRows(gid, rows) {
  const out = [];
  for (const r of rows) {
    const signed = await checkSignature(gid, r);
    let text;
    let failed = false;
    if (r.n != null) {
      ({ text, failed } = await openChainRow(gid, r, signed));
    } else {
      // from before forward secrecy: the group key itself opens it
      try {
        const key = await groupKey(gid, r.v);
        if (!key) throw new Error("no key");
        text = await decryptText(key, r.iv, r.ct);
      } catch {
        text = NO_KEY_TEXT;
        failed = true;
      }
    }
    out.push({ id: r.id, from: r.from, text, failed, ts: r.ts, v: r.v, signed, seen: new Set(r.seen_by || []) });
  }
  return out;
}

async function loadGroupHistory(gid) {
  await loadGroupDetail(gid);
  const rows = await api("/api/groups/" + gid + "/messages?limit=" + PAGE);
  state.gmsgs.set(gid, await decryptGroupRows(gid, rows));
  state.gHasOlder.set(gid, rows.length === PAGE);
  const g = state.groups.get(gid);
  if (g) g.canWrite = await canWriteGroup(gid);
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

function memberCount(n) {
  return n + (n === 1 ? " member" : " members");
}

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
  info.append(el("div", "buddy-sub", typing ? typing + "..." : memberCount(g.members)));
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
  $("chat-status").textContent = typing ? typing + "..." : memberCount(g.members);
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
  applyChatTheme();
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
  if (tooLong(text)) return;
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    setConn(false, "offline, message not sent");
    return;
  }
  const v = d.key_version;
  const cid = crypto.randomUUID();
  let msg;
  if (isForwardSecret(d, v)) {
    // lock it with the next key in my chain. That key is used once and deleted, so what I keep
    // is the text itself (under the client id) until the server sends it back with a real id
    const sealed = await withChain(state.me, gid, v, state.me, async (chain) => {
      if (!chain) return null;
      const s = await chainSeal(chain, text);
      await saveGroupPending(state.me, gid, cid, text); // before anything can go wrong
      await saveGroupSent(state.me, gid, v, s.n, text);
      return { state: s.state, sealed: s };
    });
    if (!sealed) {
      toast("you don't have this group's keys on this device yet, give it a second");
      return;
    }
    const { n, iv, ct } = sealed.sealed;
    const sig = await signGroupMessage(state.signing.privateKey, gid, v, state.me, iv, ct, n);
    msg = { type: "gmsg", group: gid, v, n, iv, ct, sig, cid };
  } else {
    // a group from before forward secrecy, waiting for its first rekey: the old way
    const key = await groupKey(gid, v);
    if (!key) {
      toast("you don't have this group's key yet, give it a second");
      return;
    }
    const { iv, ct } = await encryptText(key, text);
    const sig = await signGroupMessage(state.signing.privateKey, gid, v, state.me, iv, ct);
    msg = { type: "gmsg", group: gid, v, iv, ct, sig, cid };
  }
  if (sendWS(msg)) {
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
    const fresh = !state.groups.has(gid);
    if (fresh) await loadGroups();
    const g = state.groups.get(gid);
    if (!g) return;
    const mine = data.from === state.me;
    const list = state.gmsgs.get(gid);
    if (list && !list.some((m) => m.id === data.id)) {
      // a message with a key version we haven't fetched yet (the key was just replaced)
      const haveKey =
        data.n != null ? !!(await loadChain(state.me, gid, data.v, data.from)) : !!(await groupKey(gid, data.v));
      if (!haveKey) await loadGroupDetail(gid); // the key was just replaced, this also sets up its chains
      const [msg] = await decryptGroupRows(gid, [{ ...data, seen_by: [] }]);
      list.push(msg);
    }
    g.last_msg = data.id;
    if (!mine) {
      setGroupTypingQuiet(g, data.from);
      if (state.openGroup === gid && document.visibilityState === "visible") {
        if (list) renderMessages();
        if (!fresh) g.unread++;
        markGroupRead(gid);
      } else {
        if (!fresh) g.unread++;
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
        if (g) g.canWrite = await canWriteGroup(gid);
        renderGroupHeader();
      }
      if (groupPanel && groupPanel.id === gid) await paintGroupPanel();
    }
  } else if (data.type === "gmsg-rejected") {
    toast(
      data.reason === "not_member" ? "You're not in that group any more."
        : data.reason === "too_long" ? "That message is too long, split it into a few shorter ones."
        : data.reason === "bad_sig" ? "That message wasn't sent, its signature was refused. Reload the page and try again."
        : data.reason === "bad_n" ? "That message wasn't sent, its number was refused. Reload the page and try again."
        : "That message wasn't sent, the group key just changed. Try again."
    );
    // the text we kept for it is no use now
    if (data.cid) dropGroupPending(state.me, gid, data.cid).catch(() => {});
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
  await loadGroupDetail(gid); // sets up my chains for the new version
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
  // my own copy of the new key becomes my key chains right away
  state.gDetail.set(d.id, d);
  await ensureChains(d.id);
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
  await loadGroupDetail(gid); // sets up my chains for the new version
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
    const signChanged = m.username !== state.me && m.sign_pub && signPubState(m.username, m.sign_pub) === "changed";
    if (signChanged) {
      buttons.push(
        listButton("Trust new signing key", async () => {
          try {
            localStorage.setItem(signSlot(m.username), m.sign_pub);
          } catch {}
          // their old messages get checked again against the key we trust now
          await loadGroupHistory(gid).catch(() => {});
          if (state.openGroup === gid) renderMessages();
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
    if (signChanged) {
      who.append(el("small", "key-changed", "their signing key changed since you first saw it. Their messages show a warning until you trust it."));
    }
    if (m.pub) {
      const fp = el("small", "fp-line", "");
      fingerprintOf(m.pub).then((t) => (fp.textContent = "key " + t));
      who.append(fp);
    }
    if (m.sign_pub) {
      const sp = el("small", "fp-line", "");
      fingerprintOf(m.sign_pub).then((t) => (sp.textContent = "signing key " + t));
      who.append(sp);
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
