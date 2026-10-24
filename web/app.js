const ws = new WebSocket("ws://localhost:8765");
const log = document.getElementById("log");
const input = document.getElementById("msg");

let identity = null;
let sharedKey = null;

function addLine(text) {
  const p = document.createElement("p");
  p.textContent = text;
  log.appendChild(p);
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
      addLine("peer key: " + (await fingerprint(peerKey)));
      if (data.type === "hello") {
        ws.send(JSON.stringify({ type: "hello-reply", pub: await exportPub() }));
      }
    } else if (data.type === "msg" && sharedKey) {
      addLine("them: " + (await decryptText(sharedKey, data.iv, data.ct)));
    }
  } catch {
    addLine("[could not decrypt a message]");
  }
};

async function send() {
  if (!input.value) return;
  if (!sharedKey) {
    addLine("[no peer yet, message not sent]");
    return;
  }
  const { iv, ct } = await encryptText(sharedKey, input.value);
  ws.send(JSON.stringify({ type: "msg", iv, ct }));
  addLine("me: " + input.value);
  input.value = "";
}

document.getElementById("send").onclick = send;
input.onkeydown = (e) => {
  if (e.key === "Enter") send();
};
