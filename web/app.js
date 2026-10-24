const ws = new WebSocket("ws://localhost:8765");
const log = document.getElementById("log");
const input = document.getElementById("msg");

function addLine(text) {
  const p = document.createElement("p");
  p.textContent = text;
  log.appendChild(p);
}

ws.onmessage = (e) => addLine("them: " + e.data);

function send() {
  if (!input.value) return;
  ws.send(input.value);
  addLine("me: " + input.value);
  input.value = "";
}

document.getElementById("send").onclick = send;
input.onkeydown = (e) => { if (e.key === "Enter") send(); };
loadOrCreateIdentity().then(async (keys) => {
  document.getElementById("fp").textContent =
    "your key: " + (await fingerprint(keys.publicKey));
});
