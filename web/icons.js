// Little line icons that take the place of emojis everywhere in the app.
// Loaded right after app.js. Uses el from app.js.
//
// Icons are drawn with createElementNS (never innerHTML), so they work with the strict
// content policy, and they take the text colour of whatever they sit in (currentColor), so
// they follow every profile theme and chat theme by themselves.

const ICON_PATHS = {
  heart: [["path", { d: "M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" }]],
  repost: [
    ["polyline", { points: "17 1 21 5 17 9" }],
    ["path", { d: "M3 11V9a4 4 0 0 1 4-4h14" }],
    ["polyline", { points: "7 23 3 19 7 15" }],
    ["path", { d: "M21 13v2a4 4 0 0 1-4 4H3" }],
  ],
  reply: [
    ["polyline", { points: "15 10 5 19" }],
    ["line", { x1: "20", y1: "5", x2: "9", y2: "16" }],
  ],
  send: [
    ["line", { x1: "22", y1: "2", x2: "11", y2: "13" }],
    ["polygon", { points: "22 2 15 22 11 13 2 9 22 2" }],
  ],
  music: [
    ["path", { d: "M9 18V5l12-2v13" }],
    ["circle", { cx: "6", cy: "18", r: "3" }],
    ["circle", { cx: "18", cy: "16", r: "3" }],
  ],
  image: [
    ["rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }],
    ["circle", { cx: "8.5", cy: "8.5", r: "1.5" }],
    ["polyline", { points: "21 15 16 10 5 21" }],
  ],
  video: [
    ["polygon", { points: "23 7 16 12 23 17 23 7" }],
    ["rect", { x: "1", y: "5", width: "15", height: "14", rx: "2" }],
  ],
  lock: [
    ["rect", { x: "3", y: "11", width: "18", height: "11", rx: "2" }],
    ["path", { d: "M7 11V7a5 5 0 0 1 10 0v4" }],
  ],
  users: [
    ["path", { d: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" }],
    ["circle", { cx: "9", cy: "7", r: "4" }],
    ["path", { d: "M23 21v-2a4 4 0 0 0-3-3.87" }],
    ["path", { d: "M16 3.13a4 4 0 0 1 0 7.75" }],
  ],
  star: [["polygon", { points: "12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" }]],
  clip: [["path", { d: "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" }]],
  mic: [
    ["path", { d: "M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" }],
    ["path", { d: "M19 10v2a7 7 0 0 1-14 0v-2" }],
    ["line", { x1: "12", y1: "19", x2: "12", y2: "23" }],
    ["line", { x1: "8", y1: "23", x2: "16", y2: "23" }],
  ],
  file: [
    ["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" }],
    ["polyline", { points: "14 2 14 8 20 8" }],
  ],
  book: [
    ["path", { d: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20" }],
    ["path", { d: "M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" }],
  ],
  archive: [
    ["polyline", { points: "21 8 21 21 3 21 3 8" }],
    ["rect", { x: "1", y: "3", width: "22", height: "5" }],
    ["line", { x1: "10", y1: "12", x2: "14", y2: "12" }],
  ],
  play: [["polygon", { points: "6 3 20 12 6 21 6 3" }]],
  pause: [
    ["rect", { x: "6", y: "4", width: "4", height: "16" }],
    ["rect", { x: "14", y: "4", width: "4", height: "16" }],
  ],
  warn: [
    ["path", { d: "M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" }],
    ["line", { x1: "12", y1: "9", x2: "12", y2: "13" }],
    ["line", { x1: "12", y1: "17", x2: "12.01", y2: "17" }],
  ],
  check: [["polyline", { points: "20 6 9 17 4 12" }]],
  checks: [
    ["polyline", { points: "17 6 6 17 1 12" }],
    ["polyline", { points: "23 6 12 17 10 15" }],
  ],
  comment: [["path", { d: "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" }]],
  trash: [
    ["polyline", { points: "3 6 5 6 21 6" }],
    ["path", { d: "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" }],
    ["path", { d: "M10 11v6" }],
    ["path", { d: "M14 11v6" }],
    ["path", { d: "M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" }],
  ],
  edit: [
    ["path", { d: "M12 20h9" }],
    ["path", { d: "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" }],
  ],
  refresh: [
    ["polyline", { points: "23 4 23 10 17 10" }],
    ["polyline", { points: "1 20 1 14 7 14" }],
    ["path", { d: "M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" }],
  ],
  x: [
    ["line", { x1: "18", y1: "6", x2: "6", y2: "18" }],
    ["line", { x1: "6", y1: "6", x2: "18", y2: "18" }],
  ],
  back: [["polyline", { points: "15 18 9 12 15 6" }]],
  plus: [
    ["line", { x1: "12", y1: "5", x2: "12", y2: "19" }],
    ["line", { x1: "5", y1: "12", x2: "19", y2: "12" }],
  ],
  flag: [
    ["path", { d: "M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" }],
    ["line", { x1: "4", y1: "22", x2: "4", y2: "15" }],
  ],
};

// icons that are solid shapes (the rest are outlines)
const ICON_SOLID = new Set(["play", "pause"]);
const SVG_NS = "http://www.w3.org/2000/svg";

// icon("heart") -> an <svg> that is as big as the text around it. `filled` colours it in
// (a liked heart, a starred friend).
function icon(name, filled) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "ic ic-" + name + (filled || ICON_SOLID.has(name) ? " filled" : ""));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const [tag, attrs] of ICON_PATHS[name] || []) {
    const part = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) part.setAttribute(k, attrs[k]);
    svg.append(part);
  }
  return svg;
}

// something that sits in a line of text: an icon, then the words
function withIcon(name, text, filled) {
  const span = el("span", "ic-label");
  span.append(icon(name, filled));
  if (text) span.append(el("span", "ic-text", text));
  return span;
}

// a button with an icon and (optionally) words. Same shape as plainButton in dialogs.js.
function iconButton(name, text, onClick, cls, filled) {
  const b = el("button", cls || "");
  b.type = "button";
  b.append(icon(name, filled));
  if (text) b.append(el("span", "ic-text", text));
  if (onClick) b.onclick = onClick;
  return b;
}

// puts new icon / words into a button that iconButton made (a like button that flips)
function setIconButton(b, name, text, filled) {
  b.replaceChildren(icon(name, filled));
  if (text) b.append(el("span", "ic-text", text));
}
