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
- Profiles you customize without writing any code: display name, mood, headline, about me, interests, location, "now playing", a profile photo, 8 themes with previews, an accent colour (presets or any colour you pick), 12 bundled fonts, avatar shapes, real heart and star patterns, border and corner controls, with a live preview while you edit
- Requests and Blocked buttons in the top bar: answer friend requests (with a count) and see or unblock the people you blocked, without hunting through the buddy list
- Settings: choose what happens to messages from someone whose friend request you haven't accepted yet: let them through, hold them until you accept (up to 3, you only see a count), or make them wait. You answer the request right from the chat
- Pictures: upload a profile photo, a gallery of up to 12 photos and GIFs (click to view full size), a background picture, and stickers you drag around a small copy of your page. All without writing code
- Top friends (pick up to 8, in order), a visitor counter and mutual friends on every profile
- Friend requests (send, accept, decline, cancel, unfriend) with a popup when one arrives
- Blocking: a blocked person can't message you, can't see when you're online and can't see your profile
- Group chats: make a group from your friends, up to 30 people. Messages are end-to-end encrypted for the whole group, typing shows who is writing, your own messages say "seen by", and the Members panel lets you rename, add friends, remove people (owner) or leave
- Chat themes: every conversation (1:1 or group) can have its own look, picked from the Theme button in the chat header: 10 themes, 5 background patterns and an accent colour. It's saved per person on the server, so nobody else sees or changes what you picked. Only fixed names and a hex colour are ever stored, never free text
- Forward secrecy for 1:1 chats: every message is locked with a one-time key as well, and that key is deleted the moment the message has been read. Someone who later steals your key and has a copy of what the server stored still can't open those messages
- Too-long messages (over about 11,000 characters) are refused with a notice instead of vanishing, and flooding the socket gets dropped
- Logging out closes any tab of that session that's still connected
- Works on phones (one panel at a time)

## How it works

1. Each account gets an ECDH (P-256) keypair in the browser (Web Crypto API). The private key is non-extractable and stored in IndexedDB.
2. The public key is uploaded to the server, which acts as a key directory.
3. To talk to a friend, your browser derives a shared secret from your private key and their public key, then runs it through HKDF (SHA-256) to get a 256-bit AES key.
4. Messages are encrypted with AES-GCM (random 12-byte IV per message) before leaving the browser.
5. The server stores and forwards `{iv, ciphertext}`. It cannot read them.
6. Every key has a fingerprint (SHA-256 of the public key). Use **Verify keys** in a chat and compare fingerprints with your friend over another channel.
7. Your browser remembers the first key it saw for each friend (trust on first use) and warns you if it changes.

## Forward secrecy (1:1 chats)

Forward secrecy means that stealing a key later doesn't open messages from the past. Before this, one long-term key locked every message, so someone with a copy of the database and your key could read everything. Now each message also gets a key that only exists once.

1. Your browser makes a pile of one-time **prekeys** (100 at a time). The private halves are saved in IndexedDB and never leave your browser, the public halves go to the server.
2. To send a message, your browser asks the server for one of your friend's public prekeys. The server hands each one out once and deletes it.
3. Your browser makes a brand new key pair, and mixes two secrets into the message key with HKDF: the long-term shared key (this proves who is talking) and a secret from your new key and their prekey (this is the one-time part). Then the new private key is thrown away and the message is sent with the new public key and the id of the prekey it used.
4. Your friend's browser finds that prekey, opens the message, **saves the text on that device**, and then deletes the private prekey. From that moment the message can't be opened again from the ciphertext, by anyone.
5. When the server is running low, your browser makes and uploads more prekeys.

Things that follow from this:

- Your own sent messages are saved the same way (you can't open them from the ciphertext either). Read messages and sent messages live on the device you used, in IndexedDB, next to your private key.
- If your friend has run out of prekeys (they were offline for a long time and a lot of messages came in), the message is sent the old way and the chat shows a small "no forward secrecy" label on it. They make more when they're back online.
- Prekeys are tied to your identity key. A new key (new browser, cleared site data) means all the old prekeys are dropped.
- Prekey claims are rate limited per pair so one person can't use up someone else's supply, and a claim in a block gets a decoy so a block stays invisible.
- This is not a Double Ratchet: there's no chain of keys to keep in sync between tabs, every message simply has its own key. That's simpler, but it uses up one prekey per message.

## Group chats

1. A group has one AES-256 key per **version**. The browser of whoever makes a version generates it and wraps it (AES-GCM) once for every member, using the key it shares with that member (ECDH + HKDF, with its own HKDF label so it's never the same key that locks a 1:1 chat).
2. The server stores the wrapped copies and the ciphertext. It never has a group key in the clear.
3. The key moves to a new version whenever someone **joins**, so a new member can only read from the moment they were added, and whenever someone **leaves or is removed**, so they can't read what comes after. After a removal the owner's browser makes the new key (or another member's, if the owner is offline). Two people changing the key at once is settled by the server: one of them wins and the other is told to retry.
4. You can only add people who are your friends and haven't blocked you (or you them). A key the person already trusted is checked the same way as in 1:1 chats: if a member's key changed, nobody wraps a new group key for them until you verify it in the Members panel.
5. If you block someone (or they block you) you don't see their messages in groups and they don't see yours, and nobody is told.

## Profiles, friends and blocking

- Profiles are plain text plus pictures. Nothing you type is ever rendered as html, so there's no way to inject code through a profile.
- Uploads: png, jpg, gif and webp only (no svg). Profile photos are cropped square and every still picture is re-saved as a resized webp, which also removes hidden data like GPS from photos. Animated GIFs are checked and kept as they are so they keep moving. Limits: 5 MB for a profile photo, 4 MB and 12 per person for the gallery, 8 stickers. Pictures are stored in the database, only logged-in people can load them, and someone who blocked you doesn't show you theirs.
- Pictures are **not** encrypted, same as the rest of a profile. Only messages are.
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

The forward secrecy crypto in the browser has its own tests (Node 20+, nothing to install):

    node --test

## Limitations

This is a learning project, not Signal.

- Your private key lives in one browser. Logging in from a new browser creates a new key, so old history can't be decrypted there and friends get a key-change warning.
- Clearing site data deletes your private key and with it your ability to read old messages.
- Forward secrecy only covers 1:1 messages sent after it was added. Older messages, and everything in group chats (the group keys are wrapped with the long-term keys), are still opened by a stolen private key
- A forward secret message can only be opened once, so the text you've read is kept on your device in IndexedDB. Someone who gets your whole browser profile can read what you've read, and a second browser can't read it at all
- The server can hold back prekeys or swap one for its own. That only takes away the forward secrecy of a message, the server still can't read it (it never has the long-term keys). You only see it if the prekeys are held back, as a "no forward secrecy" label
- One prekey is used per message, so someone who is offline for a long time while a lot of messages come in can run out (those messages fall back to the old way and are labelled)
- The server still sees metadata: who talks to whom, when, message sizes, and online status
- Message settings only cover people who sent you a friend request. Nobody can message someone they have no friend request or friendship with. Being refused ("wait") is shown to the sender, unlike a block
- Blocking isn't perfectly invisible: a blocked person can tell something is off because your profile disappears and friend requests to you are refused
- The key directory is trusted on first use, only comparing fingerprints protects you from a malicious server
- Login rate limiting is in memory and resets when the server restarts
- Group messages share one key, so any member could write something that looks like it came from another member (the server shows who sent it, but the server isn't trusted). Nothing signs messages yet
- If a member loses their private key (clears site data, new browser) they can't read the group until someone removes them and adds them again, or the key is next replaced
- The server knows who is in which group, when messages are sent and how big they are
- Group "seen by" and typing are visible to every member who hasn't blocked you
- Someone who was removed keeps what they already read and the keys they already held, a new key only protects what's said afterwards

## Roadmap 

- [x] HKDF key derivation
- [x] Accounts, buddy list, history
- [x] Typing, online / last seen, delivered / read
- [x] Profiles you can customize (no code needed)
- [x] Friends and blocking
- [x] Profile comments / a wall
- [x] Image avatars, gallery, GIFs and stickers
- [x] Message requests and a settings page
- [x] Forward secrecy for 1:1 chats (one-time prekeys)
- [ ] Forward secrecy for group chats
- [ ] Sign messages so a group member can't pretend to be someone else
- [x] Group chats
- [x] Chat themes for each conversation
- [x] Fix: unblocking someone does nothing
- [x] Separate button for friend requests
- [x] Separate button that lists who you blocked
 