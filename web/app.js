const ws = new WebSocket("ws://localhost:8765");
const log = document.getElementById("log");
const input = document.getElementById("msg");
const peerEl = document.getElementById("peer");

let identity = null;
let sharedKey = null;

function timeNow() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function addMessage(who, text) {
  const row = document.createElement("div");
  row.className = "msg " + who;
  const body = document.createElement("span");
  body.className = "text";
  body.textContent = text;
  const time = document.createElement("span");
  time.className = "time";
  time.textContent = timeNow();
  row.append(body, time);
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

function addNote(text) {
  const note = document.createElement("div");
  note.className = "note";
  note.textContent = text;
  log.appendChild(note);
  log.scrollTop = log.scrollHeight;
}

async function exportPub() {
  const raw = await crypto.subtle.exportKey("raw", identity.publicKey);
  return b64(raw);
}

async function importPub(s) {
  return crypto.subtle.importKey(
    "raw", unb64(s), { name: "ECDH", namedCurve: "P-256" }, true, []
  );
}

const ready = loadOrCreateIdentity().then(async (keys) => {
  identity = keys;
  document.getElementById("fp").textContent =
    "your key: " + (await fingerprint(keys.publicKey));
});

ws.onopen = async () => {
  await ready;
  ws.send(JSON.stringify({ type: "hello", pub: await exportPub() }));
};

ws.onclose = () => {
  sharedKey = null;
  peerEl.textContent = "disconnected, is the relay running?";
};

ws.onmessage = async (e) => {
  await ready;
  let data;
  try {
    data = JSON.parse(e.data);
  } catch {
    return;
  }
  try {
    if (data.type === "hello" || data.type === "hello-reply") {
      const peerKey = await importPub(data.pub);
      sharedKey = await deriveSharedKey(identity.privateKey, peerKey);
      peerEl.textContent = "peer key: " + (await fingerprint(peerKey));
      if (data.type === "hello") {
        ws.send(JSON.stringify({ type: "hello-reply", pub: await exportPub() }));
      }
    } else if (data.type === "msg" && sharedKey) {
      addMessage("them", await decryptText(sharedKey, data.iv, data.ct));
    }
  } catch {
    addNote("could not decrypt a message");
  }
};

async function send() {
  if (!input.value) return;
  if (!sharedKey) {
    addNote("no peer yet, message not sent");
    return;
  }
  const { iv, ct } = await encryptText(sharedKey, input.value);
  ws.send(JSON.stringify({ type: "msg", iv, ct }));
  addMessage("me", input.value);
  input.value = "";
}

document.getElementById("send").onclick = send;
input.onkeydown = (e) => {
  if (e.key === "Enter") send();
};
