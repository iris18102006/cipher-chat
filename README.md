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
- Signed group messages: every group message is signed with its sender's own key, and each member's browser checks it. A message shows "signed", "not signed" or a warning if it doesn't check out, so one member can't write something that looks like it came from another
- Forward secrecy for group chats: each member has their own chain of one-use message keys, and the group key itself is deleted from your device and from the server once the chains are set up
- A song on your profile that people can play: upload an mp3, ogg, wav, flac or m4a (up to 6 MB), with a small player that never starts by itself
- A feed with its own window: short posts that you and your friends can see, with likes and shares (a share never shows the original to people who couldn't already see it)
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

### Signed group messages

Everyone in a group shares the same key, so on its own any member could build a message that looks like it came from someone else. To stop that every account also has a **signing key** (ECDSA P-256). The private half is made in your browser and never leaves it, the public half is published like your identity key.

1. A group message is signed over its group, key version, sender, message number, iv and ciphertext (each with its length in front, so fields can't be shifted into each other). It can't be moved to another group or blamed on someone else.
2. Every member's browser checks the signature. The server only checks that it has the right size, it isn't trusted to verify anything.
3. Each message shows `signed`, `not signed` (old messages), `can't check` (the sender left the group) or a warning (`fake?` if the signature doesn't match, `key changed` if their signing key isn't the one you first saw). A message with a warning is not opened.
4. Signing keys are trusted on first use, like identity keys. The Members panel shows each signing key's fingerprint and has a button to trust a changed one.

### Forward secrecy in groups

From a group's `fs_version` on, a group key is only used to **start key chains**:

1. Every member has a chain for each key version, starting from `HKDF(group key, group, version, sender)`. Everyone who has the group key can work out everybody's chain.
2. A message uses the next key in the sender's chain (and is numbered), then the chain steps forward and the old link is thrown away. A step only goes one way, a used key can't be worked out from the ones that are left.
3. As soon as a device has saved the chains (non-extractable keys in IndexedDB) it tells the server to destroy its wrapped copy of the group key (`POST /api/groups/{id}/keys/{version}/ack`) and drops the key itself. After that the group key doesn't exist in any place it could be stolen from.
4. Late or out-of-order messages are handled by keeping the keys of skipped numbers (up to 1000 per chain) until their message arrives. A key is deleted the moment it's used, so a message can only be opened once. The text you've read is kept on your device, like in 1:1 chats.
5. The server refuses a message without a signature and a number, and refuses a number that was already used by that sender in that key version, so a replay is stopped there too.
6. Groups that existed before this are marked once when the server starts: the first member to open one makes a new key version, and everything from it on is forward secret. Older messages keep the old key and stay readable the old way.

## Project layout

- `backend/main.py`: the API routes, the websocket and the rules for accounts, profiles, friends, blocks and messages
- `backend/db.py`: the SQLite schema and the connection helper (the database file `backend/cipher.db` is made on first run)
- `backend/groups.py` and `backend/chat_themes.py`: group chats (with their versioned keys and key chains) and the look of each conversation
- `backend/songs.py` and `backend/feed.py`: the song on a profile (with seeking) and the feed (posts, likes, shares)
- `web/crypto.js`: all the Web Crypto code (keys, HKDF, AES-GCM, prekeys, signing, group key chains)
- `web/app.js`: the chat screen (buddy list, messages, typing, receipts, the websocket)
- `web/profile.js`, `web/profile-media.js`, `web/friends.js`, `web/lists.js`, `web/settings.js`, `web/groups.js`, `web/chat-themes.js`, `web/profile-song.js` and `web/feed.js`: one file for each screen on top of the chat (profiles and pictures, friends, the Requests and Blocked panels, settings, group chats, chat themes, the profile song player, the feed window)
- `tests/`: the Python tests (`python -m pytest tests`) and the Node crypto tests (`node --test`)
- `server.py`: starts uvicorn

## Run it

    python3 -m venv .venv
    source .venv/bin/activate.fish   # bash/zsh: source .venv/bin/activate
    pip install -r requirements.txt
    python server.py

Open `http://127.0.0.1:8000`, sign up, then open a second browser profile (or a private window) and sign up as someone else.

If you serve it over https, set `CIPHER_SECURE_COOKIES=1` so the session cookie is only sent over https.

By default it listens on `127.0.0.1:8000`. Set `CIPHER_HOST` and `CIPHER_PORT` to change that.

## Tests

    pip install -r requirements-dev.txt
    python -m pytest tests

Unused imports and variables are checked with pyflakes:

    python -m pyflakes backend server.py tests

The crypto in the browser (forward secrecy, signing, the group key chains, and a whole group conversation across three simulated devices) has its own tests (Node 20+, nothing to install):

    node --test

## Limitations

This is a learning project, not Signal.

- Your private key lives in one browser. Logging in from a new browser creates a new key, so old history can't be decrypted there and friends get a key-change warning.
- Clearing site data deletes your private key and with it your ability to read old messages.
- Forward secrecy only covers messages sent after it was added: 1:1 messages from the prekey update on, and group messages from the group's `fs_version` on. Older ones are still opened by a stolen private key
- A forward secret message can only be opened once, so the text you've read is kept on your device in IndexedDB. Someone who gets your whole browser profile can read what you've read, and a second browser can't read it at all. That goes for groups too: the key chains live in one browser
- Group forward secrecy has gaps by design. A device that is stolen while it is running holds the chain state, so it can read what's sent after the theft until the key version changes. Your wrapped copy of a new key stays on the server until your device next opens the group and sets up its chains. Keys for messages that were skipped (up to 1000 per sender) are kept until the message shows up. If a member's device is offline for a very long time while more than that many messages are sent, the oldest ones can no longer be opened there
- The server can hold back prekeys or swap one for its own. That only takes away the forward secrecy of a message, the server still can't read it (it never has the long-term keys). You only see it if the prekeys are held back, as a "no forward secrecy" label
- One prekey is used per message, so someone who is offline for a long time while a lot of messages come in can run out (those messages fall back to the old way and are labelled)
- The server still sees metadata: who talks to whom, when, message sizes, and online status
- Message settings only cover people who sent you a friend request. Nobody can message someone they have no friend request or friendship with. Being refused ("wait") is shown to the sender, unlike a block
- Blocking isn't perfectly invisible: a blocked person can tell something is off because your profile disappears and friend requests to you are refused
- The key directory is trusted on first use, only comparing fingerprints protects you from a malicious server
- Login rate limiting is in memory and resets when the server restarts
- Group messages are signed, but signing keys are trusted on first use just like identity keys: a malicious server that swaps someone's signing key before you ever saw it can't be caught. Comparing signing key fingerprints in the Members panel is what protects you. Messages from before signing existed show as "not signed", and a message from someone who has left the group shows "can't check"
- If a member loses their private key (clears site data, new browser) they can't read the group until someone removes them and adds them again, or the key is next replaced
- The server knows who is in which group, when messages are sent and how big they are
- Group "seen by" and typing are visible to every member who hasn't blocked you
- Posts in the feed and the songs on profiles are not end-to-end encrypted (only messages are). The server can read them, and friends can see them. A share never shows the original post to people who couldn't see it, but the server knows about it
- A profile song is only checked by looking at the first bytes of the file. It's played with a plain `<audio>` element and is served with `nosniff` and a sandbox policy
- Feed rate limits (15 posts or shares per 10 minutes) are in memory and reset when the server restarts
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
- [x] You can share photos, videos and files
- [x] Relationship statuses made possible
- [x] Pinnig a friend is possible now in chats 
- [x] Now there is a feed where you can post your thoughts
- [x] You can choose what friends to show in your profile according to your peferences
- [ ] Profiles will have the possibility of listening the song into their profile, not just the name
- [ ] Posts will have the ability to get shared
- [ ] The feed will have a special window so it doesn't have to look ugly

