const fs = require("fs");
const source = fs.readFileSync("web/crypto.js", "utf8");
if (!source.includes("exportPrekeys") || !source.includes("importPrekeys")) throw new Error("prekey vault support missing");
if (!source.includes("prekeys: await exportPrekeys(username)")) throw new Error("prekeys not included in vault");
