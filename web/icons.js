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
};
