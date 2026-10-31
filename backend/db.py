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
        conn.commit()
    finally:
        conn.close()
