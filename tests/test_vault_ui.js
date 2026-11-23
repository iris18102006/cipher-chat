const fs = require("fs");
const crypto = fs.readFileSync("web/crypto.js", "utf8");
const settings = fs.readFileSync("web/settings.js", "utf8");
if (!crypto.includes("PBKDF2") || !crypto.includes("AES-GCM")) throw new Error("browser vault crypto missing");
if (!crypto.includes("makeRecoveryVault") || !crypto.includes("openRecoveryVault")) throw new Error("vault functions missing");
if (!settings.includes("/api/key-vault")) throw new Error("vault settings controls missing");
