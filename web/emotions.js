// Small, keyboard-friendly emoji and text-emotion picker for the chat composer.
// Picking an item inserts text at the cursor; it never sends until the user presses Send.
const EMOTIONS = [
  [":)", "smile"], [":3", "cat smile"], [":o)", "surprised smile"], [";)" , "wink"],
  [":(", "sad"], [":'(", "crying"], [":D", "big smile"], ["<3", "heart"],
  ["😀", "grinning"], ["😂", "laughing"], ["😍", "love"], ["😭", "crying"], ["😡", "angry"], ["😎", "cool"]
];

const emotionPanel = $("emotion-panel");
const emotionButton = $("emotion-btn");
const messageBox = $("msg");

function closeEmotions() {
  emotionPanel.hidden = true;
  emotionButton.setAttribute("aria-expanded", "false");
}

function insertEmotion(value) {
  const start = messageBox.selectionStart;
  const end = messageBox.selectionEnd;
  messageBox.setRangeText(value, start, end, "end");
  messageBox.dispatchEvent(new Event("input", { bubbles: true }));
  messageBox.focus();
  closeEmotions();
}

for (const [value, label] of EMOTIONS) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "emotion-choice";
  b.textContent = value;
  b.title = label;
  b.setAttribute("aria-label", label + " " + value);
  b.onclick = () => insertEmotion(value);
  emotionPanel.append(b);
}

emotionButton.onclick = () => {
  const open = emotionPanel.hidden;
  emotionPanel.hidden = !open;
  emotionButton.setAttribute("aria-expanded", String(open));
  if (open) messageBox.focus();
};

document.addEventListener("mousedown", (e) => {
  if (!emotionPanel.hidden && !emotionPanel.contains(e.target) && e.target !== emotionButton) closeEmotions();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !emotionPanel.hidden) closeEmotions();
});
