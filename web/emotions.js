// Emoji and text-emotion picker. Choices are inserted at the cursor and never sent automatically.
const EMOTION_SECTIONS = [
  ["Faces & emotions", "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😋 😛 😜 🤪 🤨 🧐 🤓 😎 🥳 😏 😢 😭 😡 🤬 😱 😴 🤔 🤗 🤭 🤫 🤥 😬 🙄 😮 🤯 🥺"],
  ["Text faces", ":3 | :) | :D | :o) | ;) | :P | :( | :'(? | -_- | ^_^ | <3 | T_T"],
  ["People & gestures", "👋 🤚 ✋ 🖖 👏 🙌 🤝 👍 👎 👌 ✌️ 🤞 🤟 🤘 👊 💪 🙏 💅 👀 🫶 ❤️ 💔"],
  ["Animals & nature", "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🐔 🐧 🐦 🦄 🐝 🦋 🐌 🐙 🐠 🐳 🌸 🌻 🌈 ⭐ 🔥 ☀️"],
  ["Food & drink", "🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🍒 🍑 🥭 🍕 🍔 🍟 🌭 🌮 🍿 🍩 🍪 🎂 🍫 ☕ 🧋 🍺 🍷 🍸"],
  ["Activities & fun", "⚽ 🏀 🏈 ⚾ 🎾 🏆 🎮 🎲 🎯 🎨 🎵 🎶 🎸 🎤 🎧 🎬 🎉 🎁 🎈 🚀"],
  ["Travel & places", "🚗 🚕 🚌 🚓 🚑 ✈️ 🚲 🚂 🚢 🏠 🏢 🏥 🏖️ 🌋 🗺️"],
  ["Objects & symbols", "💡 📱 💻 ⌚ 📷 🔑 🔒 📌 📎 ✏️ 📚 💰 💎 ✅ ❌ ❗ ❓ 💯 💥 ✨"]
].map(([name, values]) => [name, values.split(values.includes("|") ? "|" : " ").map((value) => value.trim()).filter(Boolean)]);

const emotionPanel = $("emotion-panel");
const emotionButton = $("emotion-btn");
const messageBox = $("msg");
function closeEmotions() { emotionPanel.hidden = true; emotionButton.setAttribute("aria-expanded", "false"); }
function insertEmotion(value) {
  messageBox.setRangeText(value, messageBox.selectionStart, messageBox.selectionEnd, "end");
  messageBox.dispatchEvent(new Event("input", { bubbles: true }));
  messageBox.focus();
  closeEmotions();
}
for (const [name, values] of EMOTION_SECTIONS) {
  const section = el("section", "emotion-section");
  section.append(el("h3", "", name));
  const grid = el("div", "emotion-grid");
  for (const value of values) {
    const b = el("button", "emotion-choice", value);
    b.type = "button";
    b.title = value;
    b.setAttribute("aria-label", "insert " + value);
    b.onclick = () => insertEmotion(value);
    grid.append(b);
  }
  section.append(grid);
  emotionPanel.append(section);
}
emotionButton.onclick = () => {
  const open = emotionPanel.hidden;
  emotionPanel.hidden = !open;
  emotionButton.setAttribute("aria-expanded", String(open));
};
document.addEventListener("mousedown", (e) => { if (!emotionPanel.hidden && !emotionPanel.contains(e.target) && e.target !== emotionButton) closeEmotions(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !emotionPanel.hidden) closeEmotions(); });
