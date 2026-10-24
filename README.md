# cipher-chat

End-to-end encrypted web chat. Work in progress.

The relay server only ever sees ciphertext. Keys are generated in your browser and the private key never leaves it.

## How it works

1. Each browser generates an ECDH (P-256) keypair with the Web Crypto API. The private key is non-extractable and stored in IndexedDB.
2. When two clients connect, they swap public keys through the relay.
3. Both sides derive the same shared secret from their private key and the other's public key.
4. Messages are encrypted with AES-GCM (random 12-byte IV per message) before leaving the browser.
5. The relay just forwards the JSON blobs. It cannot read them.
6. Each user has a key fingerprint (SHA-256 of the public key). Compare fingerprints with your contact over another channel to make sure nobody swapped keys.

## Run it

Terminal 1, the relay:

    python3 -m venv .venv
    source .venv/bin/activate.fish
    pip install -r requirements.txt
    python server.py

Terminal 2, the web server:

    cd web
    python3 -m http.server 8000 --bind 127.0.0.1

Open `http://127.0.0.1:8000` in two different browser profiles (or one normal window and one private window).

## Limitations

This is a learning project, not Signal.

- 1-to-1 only, a third client breaks the shared key
- No authentication beyond manually comparing fingerprints
- The raw ECDH output is used as the AES key (no HKDF yet)
- No forward secrecy, a stolen private key decrypts everything
- The relay still sees metadata: who connects, when, and message sizes
- No message history, messages vanish on refresh

## Roadmap
