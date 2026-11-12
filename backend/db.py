"""SQLite connection and schema for cipher-chat."""
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent / "cipher.db"


def connect():
    # FastAPI may run a dependency and its endpoint on different worker threads,
    # and each request gets its own connection, so sharing across threads is safe
    conn = sqlite3.connect(DB_PATH, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _add_column(conn, table, column, ddl):
    cols = [r["name"] for r in conn.execute(f"PRAGMA table_info({table})")]
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


def init_db():
    conn = connect()
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                iv TEXT NOT NULL,
                ct TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                delivered_at TEXT,
                read_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_messages_pair
                ON messages (sender_id, recipient_id, id);
            CREATE INDEX IF NOT EXISTS idx_messages_recipient
                ON messages (recipient_id, read_at);
            -- one row per pair, requester asked, addressee has to accept
            CREATE TABLE IF NOT EXISTS friendships (
                requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (requester_id, addressee_id),
                CHECK (requester_id != addressee_id)
            );
            CREATE INDEX IF NOT EXISTS idx_friendships_addressee
                ON friendships (addressee_id, status);
            CREATE TABLE IF NOT EXISTS blocks (
                blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (blocker_id, blocked_id),
                CHECK (blocker_id != blocked_id)
            );
            CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks (blocked_id);
            -- who visited whose profile (one row per visitor, so it counts people not refreshes)
            CREATE TABLE IF NOT EXISTS profile_visits (
                profile_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                visitor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                last_visit TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (profile_id, visitor_id)
            );
            CREATE TABLE IF NOT EXISTS profile_comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                profile_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                body TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_profile_comments_profile
                ON profile_comments (profile_id, id DESC);
            -- profile pictures and the photo/gif gallery. The bytes live in the
            -- database so there are no file paths to get wrong or traverse.
            CREATE TABLE IF NOT EXISTS images (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                kind TEXT NOT NULL,
                mime TEXT NOT NULL,
                data BLOB NOT NULL,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                animated INTEGER NOT NULL DEFAULT 0,
                caption TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_images_owner ON images (owner_id, kind, id);
            -- the song someone can put on their profile. One per person, the bytes live in
            -- the database like pictures do, so there are no file paths to get wrong
            CREATE TABLE IF NOT EXISTS songs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
                mime TEXT NOT NULL,
                data BLOB NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            -- the feed: short posts that you and your friends can see. A post that has
            -- shared_id set is a share of somebody else's post (body is the note that
            -- came with it, may be empty). If the original is deleted the share stays,
            -- and says the original is gone.
            CREATE TABLE IF NOT EXISTS posts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                body TEXT NOT NULL DEFAULT '',
                shared_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
                -- 1 for a share. Kept apart from shared_id because that goes null when the
                -- original is deleted, and the share should still say it was a share
                is_share INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_posts_author ON posts (author_id, id DESC);
            CREATE INDEX IF NOT EXISTS idx_posts_shared ON posts (shared_id);
            CREATE TABLE IF NOT EXISTS post_likes (
                post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (post_id, user_id)
            );
            -- group chats. The server only ever stores ciphertext: every message is
            -- encrypted with a group key, and that key is stored once per member,
            -- wrapped (encrypted) for them in the browser of whoever made it.
            CREATE TABLE IF NOT EXISTS chat_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                -- goes up by one every time the key is replaced (someone joins or leaves)
                key_version INTEGER NOT NULL DEFAULT 1,
                -- 1 after someone left or was removed: a member's browser must pick a new key
                rekey_needed INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS chat_group_members (
                group_id INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                -- a new member can only read messages from the key version they joined at
                joined_version INTEGER NOT NULL,
                joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_read_id INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (group_id, user_id)
            );
            CREATE INDEX IF NOT EXISTS idx_group_members_user ON chat_group_members (user_id);
            CREATE TABLE IF NOT EXISTS chat_group_keys (
                group_id INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                version INTEGER NOT NULL,
                wrapper_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                -- the public key the wrapper had when they wrapped it, needed to unwrap it
                wrapper_pub TEXT NOT NULL,
                iv TEXT NOT NULL,
                wk TEXT NOT NULL,
                PRIMARY KEY (group_id, user_id, version)
            );
            CREATE TABLE IF NOT EXISTS chat_group_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
                sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                key_version INTEGER NOT NULL,
                iv TEXT NOT NULL,
                ct TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_group_messages_group
                ON chat_group_messages (group_id, id);
            -- how each person wants one conversation to look. Only for them: the other
            -- people in the chat keep their own look. target_id is the other user's id
            -- (kind 'dm') or a group's id (kind 'group').
            CREATE TABLE IF NOT EXISTS chat_themes (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                kind TEXT NOT NULL CHECK (kind IN ('dm', 'group')),
                target_id INTEGER NOT NULL,
                theme TEXT NOT NULL DEFAULT 'classic',
                accent TEXT NOT NULL DEFAULT '',
                pattern TEXT NOT NULL DEFAULT 'none',
                PRIMARY KEY (user_id, kind, target_id)
            );
            -- one-time public prekeys for forward secrecy. Every person uploads a batch;
            -- the private halves stay in their browser. The server hands each one out
            -- once (and deletes it), so no two messages ever use the same one.
            CREATE TABLE IF NOT EXISTS prekeys (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                id INTEGER NOT NULL,
                pub TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, id)
            );
            """
        )
        # added after the first version, so migrate old databases in place
        _add_column(conn, "users", "public_key", "TEXT")
        _add_column(conn, "users", "last_seen", "TEXT")
        # 1 when the recipient had blocked the sender: stored so the sender's own
        # history stays intact, but never shown or delivered to the recipient
        _add_column(conn, "messages", "hidden", "INTEGER NOT NULL DEFAULT 0")
        # profile fields, all optional, all plain text (the browser never renders them as html)
        _add_column(conn, "users", "display_name", "TEXT NOT NULL DEFAULT ''")
        _add_column(conn, "users", "mood", "TEXT NOT NULL DEFAULT ''")
        _add_column(conn, "users", "headline", "TEXT NOT NULL DEFAULT ''")
        _add_column(conn, "users", "about_me", "TEXT NOT NULL DEFAULT ''")
        _add_column(conn, "users", "interests", "TEXT NOT NULL DEFAULT ''")
        _add_column(conn, "users", "location", "TEXT NOT NULL DEFAULT ''")
        _add_column(conn, "users", "song", "TEXT NOT NULL DEFAULT ''")
        _add_column(conn, "users", "avatar", "TEXT NOT NULL DEFAULT ''")
        _add_column(conn, "users", "theme", "TEXT NOT NULL DEFAULT 'classic'")
        _add_column(conn, "users", "accent", "TEXT NOT NULL DEFAULT ''")
        _add_column(conn, "users", "custom_theme", "TEXT NOT NULL DEFAULT '{}'")
        _add_column(conn, "users", "top_friends", "TEXT NOT NULL DEFAULT '[]'")
        # image profile: the old emoji `avatar` column is no longer used
        _add_column(conn, "users", "avatar_id", "INTEGER")
        _add_column(conn, "users", "bg_image_id", "INTEGER")
        _add_column(conn, "users", "stickers", "TEXT NOT NULL DEFAULT '[]'")
        # what happens to messages from someone whose friend request I haven't accepted yet:
        # allow (they arrive), ask (held until I accept) or wait (not allowed)
        _add_column(conn, "users", "msg_policy", "TEXT NOT NULL DEFAULT 'allow'")
        # forward secrecy: 1 = locked with the long-term shared key (all old messages),
        # 2 = also mixed with a one-time prekey. eph is the sender's one-time public key,
        # pid is which of the recipient's prekeys was used, cid is the id the sender's
        # browser picked (it finds the sender's own copy of the text with it)
        _add_column(conn, "messages", "v", "INTEGER NOT NULL DEFAULT 1")
        _add_column(conn, "messages", "eph", "TEXT")
        _add_column(conn, "messages", "pid", "INTEGER")
        _add_column(conn, "messages", "cid", "TEXT")
        # signing: an ECDSA public key per person (the private half stays in their browser),
        # so a group message can prove who wrote it even though the whole group shares a key
        _add_column(conn, "users", "sign_pub", "TEXT")
        # the signature a group message was sent with (base64, 64 bytes), null on older messages
        _add_column(conn, "chat_group_messages", "sig", "TEXT")
        # the message's number in its sender's key chain (forward secrecy), null on older messages
        _add_column(conn, "chat_group_messages", "n", "INTEGER")
        # 1 once a member's device has set up its key chains and had its wrapped copy of the
        # group key destroyed (iv and wk emptied). The row stays so we know they hold the version
        _add_column(conn, "chat_group_keys", "consumed", "INTEGER NOT NULL DEFAULT 0")
        # Forward secrecy starts at key version fs_version: messages from then on are numbered
        # and their keys are not kept. Groups that already exist get fs_version = their
        # next version and are marked for a rekey, so the first member to open them
        # makes that version and everything from it on is forward secret. Older messages
        # keep working the old way and keep their keys. New groups start at 1.
        if "fs_version" not in [r["name"] for r in conn.execute("PRAGMA table_info(chat_groups)")]:
            conn.execute("ALTER TABLE chat_groups ADD COLUMN fs_version INTEGER NOT NULL DEFAULT 1")
            conn.execute("UPDATE chat_groups SET fs_version = key_version + 1, rekey_needed = 1")
        # a number can only be used once per sender and key version, which stops replays
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_group_messages_chain "
            "ON chat_group_messages (group_id, sender_id, key_version, n) WHERE n IS NOT NULL"
        )
        conn.commit()
    finally:
        conn.close()
