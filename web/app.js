const ws = new WebSocket("ws://localhost:8765");
const log = document.getElementById("log");
const input = document.getElementById("msg");

let identity = null;
let peerKey = null;

function addLine(text) {
  const p = document.createElement("p");
  p.textContent = text;
  log.appendChild(p);
}

async function exportPub() {
  const raw = await crypto.subtle.exportKey("raw", identity.publicKey);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}

async function importPub(b64) {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "raw", raw, { name: "ECDH", namedCurve: "P-256" }, true, []
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

ws.onmessage = async (e) => {
  await ready;
  let data;
  try {
    data = JSON.parse(e.data);
  } catch {
    return;
  }
  if (data.type === "hello" || data.type === "hello-reply") {
    peerKey = await importPub(data.pub);
    addLine("peer key: " + (await fingerprint(peerKey)));
    if (data.type === "hello") {
      ws.send(JSON.stringify({ type: "hello-reply", pub: await exportPub() }));
    }
  } else if (data.type === "msg") {
    addLine("them: " + data.text);
  }
};

function send() {
  if (!input.value) return;
  ws.send(JSON.stringify({ type: "msg", text: input.value }));
  addLine("me: " + input.value);
  input.value = "";
}

document.getElementById("send").onclick = send;
input.onkeydown = (e) => {
  if (e.key === "Enter") send();
};
