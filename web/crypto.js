async function generateIdentity() {
  return crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false, // private key can't be exported
    ["deriveKey"]
  );
}
