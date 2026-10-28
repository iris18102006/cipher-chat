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
            """
        )
        # added after the first version, so migrate old databases in place
        _add_column(conn, "users", "public_key", "TEXT")
        _add_column(conn, "users", "last_seen", "TEXT")
        conn.commit()
    finally:
        conn.close()
