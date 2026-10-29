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
- Profiles you customize without writing any code: display name, mood, headline, about me, interests, location, "now playing", an emoji avatar, 8 themes and an accent colour, with a live preview while you edit
- Top friends (pick up to 8, in order), a visitor counter and mutual friends on every profile
- Friend requests (send, accept, decline, cancel, unfriend) with a popup when one arrives
- Blocking: a blocked person can't message you, can't see when you're online and can't see your profile
- Works on phones (one panel at a time)

## How it works

1. Each account gets an ECDH (P-256) keypair in the browser (Web Crypto API). The private key is non-extractable and stored in IndexedDB.
2. The public key is uploaded to the server, which acts as a key directory.
3. To talk to a friend, your browser derives a shared secret from your private key and their public key, then runs it through HKDF (SHA-256) to get a 256-bit AES key.
4. Messages are encrypted with AES-GCM (random 12-byte IV per message) before leaving the browser.
5. The server stores and forwards `{iv, ciphertext}`. It cannot read them.
6. Every key has a fingerprint (SHA-256 of the public key). Use **Verify keys** in a chat and compare fingerprints with your friend over another channel.
7. Your browser remembers the first key it saw for each friend (trust on first use) and warns you if it changes.

## Profiles, friends and blocking

- Profiles are plain text and an emoji. Nothing you type is ever rendered as html, so there's no way to inject code through a profile.
- Themes are presets (`web/themes.css`), they only change a handful of colour variables.
- Anyone logged in can look at a profile. Profiles are **not** encrypted, only messages are, so don't put secrets in your about me.
- You can message anyone who hasn't blocked you, friends or not. Friends just get their own section in the buddy list and can go in your top friends.
- When someone blocks you, your messages to them are still saved (so your own history stays complete) but they are never delivered or shown to them, and you're not told. They also see you as permanently offline. Blocking someone also ends your friendship.

The websocket (`/ws`) needs a valid session cookie and a same-origin `Origin` header, so other sites and logged-out visitors can't connect.

## Run it

    python3 -m venv .venv
    source .venv/bin/activate.fish   # bash/zsh: source .venv/bin/activate
    pip install -r requirements.txt
    python server.py

Open `http://127.0.0.1:8000`, sign up, then open a second browser profile (or a private window) and sign up as someone else.

If you serve it over https, set `CIPHER_SECURE_COOKIES=1` so the session cookie is only sent over https.

## Tests

    pip install -r requirements-dev.txt
    python -m pytest tests

## Limitations

This is a learning project, not Signal.

- Your private key lives in one browser. Logging in from a new browser creates a new key, so old history can't be decrypted there and friends get a key-change warning.
- Clearing site data deletes your private key and with it your ability to read old messages.
- No forward secrecy, a stolen private key decrypts everything
- The server still sees metadata: who talks to whom, when, message sizes, and online status
- Blocking isn't perfectly invisible: a blocked person can tell something is off because your profile disappears and friend requests to you are refused
- The key directory is trusted on first use, only comparing fingerprints protects you from a malicious server
- Login rate limiting is in memory and resets when the server restarts
- 1-to-1 only, no group chats yet
- Avatars are emoji only, no image uploads yet

## Roadmap

- [x] HKDF key derivation
- [x] Accounts, buddy list, history
- [x] Typing, online / last seen, delivered / read
- [x] Profiles you can customize (no code needed)
- [x] Friends and blocking
- [ ] Profile comments / a wall
- [ ] Image avatars
- [ ] Forward secrecy with a ratchet
- [ ] Group chats
