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
- Works on phones (one panel at a time)

## How it works

1. Each account gets an ECDH (P-256) keypair in the browser (Web Crypto API). The private key is non-extractable and stored in IndexedDB.
2. The public key is uploaded to the server, which acts as a key directory.
3. To talk to a friend, your browser derives a shared secret from your private key and their public key, then runs it through HKDF (SHA-256) to get a 256-bit AES key.
4. Messages are encrypted with AES-GCM (random 12-byte IV per message) before leaving the browser.
5. The server stores and forwards `{iv, ciphertext}`. It cannot read them.
6. Every key has a fingerprint (SHA-256 of the public key). Use **Verify keys** in a chat and compare fingerprints with your friend over another channel.
7. Your browser remembers the first key it saw for each friend (trust on first use) and warns you if it changes.

## Group chats

1. A group has one AES-256 key per **version**. The browser of whoever makes a version generates it and wraps it (AES-GCM) once for every member, using the key it shares with that member (ECDH + HKDF, with its own HKDF label so it's never the same key that locks a 1:1 chat).
2. The server stores the wrapped copies and the ciphertext. It never has a group key in the clear.
3. The key moves to a new version whenever someone **joins**, so a new member can only read from the moment they were added, and whenever someone **leaves or is removed**, so they can't read what comes after. After a removal the owner's browser makes the new key (or another member's, if the owner is offline). Two people changing the key at once is settled by the server: one of them wins and the other is told to retry.
4. You can only add people who are your friends and haven't blocked you (or you them). A key the person already trusted is checked the same way as in 1:1 chats: if a member's key changed, nobody wraps a new group key for them until you verify it in the Members panel.
5. If you block someone (or they block you) you don't see their messages in groups and they don't see yours, and nobody is told.
