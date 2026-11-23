// Static guardrails for the browser recovery primitives.
const fs = require("fs");
const source = fs.readFileSync("web/crypto.js", "utf8");
if (!source.includes('exportKey("pkcs8"')) throw new Error("private-key export missing");
if (!source.includes("importIdentityPrivate")) throw new Error("identity import missing");
if (!source.includes("importSigningPrivate")) throw new Error("signing-key import missing");
