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
};
