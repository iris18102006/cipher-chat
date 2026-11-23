const fs = require("fs");
const source = fs.readFileSync("web/crypto.js", "utf8");
if (!source.includes("exportGroupState") || !source.includes("importGroupState")) throw new Error("group vault support missing");
if (!source.includes("groups: await exportGroupState(username)")) throw new Error("group state not included in vault");
