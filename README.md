# cipher-chat

End-to-end encrypted web chat with a 2000s social-site look. Work in progress.

The server only ever sees ciphertext. Keys are generated in your browser and the private key never leaves it.

## Features

- Accounts (argon2 password hashes, httpOnly session cookies that expire after 30 days)
- Buddy list with online dots, last seen, unread badges and search
- Direct messages with bubbles, timestamps, day separators and autoscroll
- Typing indicator, delivered and read ticks
- Message history that survives refreshes (stored encrypted, decrypted in your browser)
- Key-change warning: if a friend's key changes, the composer locks until you trust the new key
- Works on phones (one panel at a time)

## How it works

1. Each account gets an ECDH (P-256) keypair in the browser (Web Crypto API). The private key is non-extractable and stored in IndexedDB.
2. The public key is uploaded to the server, which acts as a key directory.
3. To talk to a friend, your browser derives a shared secret from your private key and their public key, then runs it through HKDF (SHA-256) to get a 256-bit AES key.
4. Messages are encrypted with AES-GCM (random 12-byte IV per message) before leaving the browser.
5. The server stores and forwards `{iv, ciphertext}`. It cannot read them.
6. Every key has a fingerprint (SHA-256 of the public key). Use **Verify keys** in a chat and compare fingerprints with your friend over another channel.
7. Your browser remembers the first key it saw for each friend (trust on first use) and warns you if it changes.

The websocket (`/ws`) needs a valid session cookie and a same-origin `Origin` header, so other sites and logged-out visitors can't connect.

## Run it

    python3 -m venv .venv
    source .venv/bin/activate.fish   # bash/zsh: source .venv/bin/activate
    pip install -r requirements.txt
    python server.py

Open `http://127.0.0.1:8000`, sign up, then open a second browser profile (or a private window) and sign up as someone else.

If you serve it over https, set `CIPHER_SECURE_COOKIES=1` so the session cookie is only sent over https.

