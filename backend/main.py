import base64
import hashlib
import json
import logging
import os
import re
import secrets
import sqlite3
import time
from collections import defaultdict
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import (
    Cookie,
    Depends,
    FastAPI,
    HTTPException,
    Query,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .db import connect, init_db

COOKIE = "session"
SESSION_DAYS = 30
USERNAME_RE = re.compile(r"^[a-z0-9_]{3,20}$")
MAX_CT_LEN = 16_000  # base64 chars of ciphertext, roughly 12 KB of text
PUB_LEN = 88  # base64 of an uncompressed P-256 point (65 bytes)
WEB_DIR = Path(__file__).parent.parent / "web"

# profile theme presets (the css for each lives in web/themes.css)
THEMES = ("classic", "emo", "kawaii", "neon", "forest", "sunset", "gothic", "terminal")
ACCENT_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
# max length of each free-text profile field
PROFILE_LIMITS = {
    "display_name": 30,
    "mood": 40,
    "headline": 80,
    "about_me": 600,
    "interests": 200,
    "location": 40,
    "song": 80,
}
MAX_TOP_FRIENDS = 8

# set CIPHER_SECURE_COOKIES=1 when serving over https
SECURE_COOKIES = os.environ.get("CIPHER_SECURE_COOKIES") == "1"

log = logging.getLogger("cipher")
app = FastAPI(docs_url=None, redoc_url=None)
ph = PasswordHasher()
init_db()

# verified against when the username doesn't exist, so login takes the same
# time whether or not the account is real (no username enumeration)
DUMMY_HASH = ph.hash("not-a-real-password")


def get_conn():
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()


class Credentials(BaseModel):
    username: str
    password: str


class KeyBody(BaseModel):
    pub: str


class ProfileBody(BaseModel):
    # every field is optional so the editor can save just what changed
    display_name: str | None = None
    mood: str | None = None
    headline: str | None = None
    about_me: str | None = None
    interests: str | None = None
    location: str | None = None
    song: str | None = None
    avatar: str | None = None
    theme: str | None = None
    accent: str | None = None


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def valid_pub(pub: str) -> bool:
    if len(pub) != PUB_LEN:
        return False
    try:
        raw = base64.b64decode(pub, validate=True)
    except ValueError:
        return False
    return len(raw) == 65 and raw[0] == 4


def clean_text(value: str, limit: int, field: str, multiline: bool = False) -> str:
    """Strip control characters and surrounding space, then enforce the length limit."""
    keep = "\n" if multiline else ""
    value = "".join(ch for ch in value if ch.isprintable() or ch in keep)
    value = value.replace("\r", "").strip()
    if len(value) > limit:
        raise HTTPException(400, f"{field.replace('_', ' ')} is too long (max {limit})")
    return value


def clean_avatar(value: str) -> str:
    # an avatar is a single emoji (or a few joined together), never ascii text
    value = value.strip()
    if len(value) > 8 or any(ord(ch) < 128 for ch in value):
        raise HTTPException(400, "pick an emoji for your avatar")
    return value


# ---------- login rate limiting (in memory, per ip + username) ----------

FAIL_LIMIT = 8
FAIL_WINDOW = 5 * 60
_fails: dict[str, list[float]] = defaultdict(list)


def _fail_key(ip: str, username: str) -> str:
    return f"{ip}|{username}"


def check_rate_limit(key: str):
    now = time.time()
    recent = [t for t in _fails[key] if now - t < FAIL_WINDOW]
    _fails[key] = recent
    if len(recent) >= FAIL_LIMIT:
        raise HTTPException(429, "too many tries, wait a few minutes")


# ---------- sessions ----------


def start_session(conn, response: Response, user_id: int):
    # clean out expired sessions while we're here
    conn.execute(
        "DELETE FROM sessions WHERE created_at < datetime('now', ?)",
        (f"-{SESSION_DAYS} days",),
    )
    token = secrets.token_urlsafe(32)
    conn.execute(
        "INSERT INTO sessions (token, user_id) VALUES (?, ?)",
        (hash_token(token), user_id),
    )
    conn.commit()
    response.set_cookie(
        COOKIE,
        token,
        httponly=True,
        samesite="lax",
        secure=SECURE_COOKIES,
        max_age=60 * 60 * 24 * SESSION_DAYS,
    )


def user_from_token(conn, token: str | None):
    if not token:
        return None
    return conn.execute(
        "SELECT users.id, users.username FROM sessions "
        "JOIN users ON users.id = sessions.user_id "
        "WHERE sessions.token = ? AND sessions.created_at >= datetime('now', ?)",
        (hash_token(token), f"-{SESSION_DAYS} days"),
    ).fetchone()


def current_user(session: str | None = Cookie(default=None), conn=Depends(get_conn)):
    row = user_from_token(conn, session)
    if not row:
        raise HTTPException(401, "not logged in")
    return row


def get_peer(conn, username: str):
    peer = conn.execute(
        "SELECT id, username, public_key, last_seen FROM users WHERE username = ?",
        (username.lower(),),
    ).fetchone()
    if not peer:
        raise HTTPException(404, "no such user")
    return peer


# ---------- auth routes ----------


@app.post("/api/signup")
def signup(creds: Credentials, response: Response, conn=Depends(get_conn)):
    username = creds.username.strip().lower()
    if not USERNAME_RE.match(username):
        raise HTTPException(400, "username must be 3-20 chars: a-z, 0-9, _")
    if not 8 <= len(creds.password) <= 128:
        raise HTTPException(400, "password must be 8-128 characters")
    try:
        cur = conn.execute(
            "INSERT INTO users (username, password_hash) VALUES (?, ?)",
            (username, ph.hash(creds.password)),
        )
        conn.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(409, "that username is taken")
    start_session(conn, response, cur.lastrowid)
    return {"username": username}


@app.post("/api/login")
def login(
    creds: Credentials, request: Request, response: Response, conn=Depends(get_conn)
):
    username = creds.username.strip().lower()
    key = _fail_key(request.client.host if request.client else "?", username)
    check_rate_limit(key)
    row = conn.execute(
        "SELECT id, password_hash FROM users WHERE username = ?", (username,)
    ).fetchone()
    try:
        ph.verify(row["password_hash"] if row else DUMMY_HASH, creds.password)
        if not row:
            raise VerifyMismatchError()
    except VerifyMismatchError:
        _fails[key].append(time.time())
        raise HTTPException(401, "wrong username or password")
    _fails.pop(key, None)
    start_session(conn, response, row["id"])
    return {"username": username}


@app.post("/api/logout")
def logout(
    response: Response,
    session: str | None = Cookie(default=None),
    conn=Depends(get_conn),
):
    if session:
        conn.execute("DELETE FROM sessions WHERE token = ?", (hash_token(session),))
        conn.commit()
    response.delete_cookie(COOKIE)
    return {"ok": True}


@app.get("/api/me")
def me(user=Depends(current_user)):
    return {"username": user["username"]}


# ---------- keys, contacts, history ----------


@app.put("/api/key")
def put_key(body: KeyBody, user=Depends(current_user), conn=Depends(get_conn)):
    if not valid_pub(body.pub):
        raise HTTPException(400, "that doesn't look like a P-256 public key")
    conn.execute(
        "UPDATE users SET public_key = ? WHERE id = ?", (body.pub, user["id"])
    )
    conn.commit()
    return {"ok": True}


@app.get("/api/contacts")
def contacts(user=Depends(current_user), conn=Depends(get_conn)):
    rows = conn.execute(
        """
        SELECT u.username, u.public_key, u.last_seen,
               (SELECT COUNT(*) FROM messages m
                 WHERE m.sender_id = u.id AND m.recipient_id = :me
                   AND m.read_at IS NULL) AS unread,
               (SELECT MAX(m.id) FROM messages m
                 WHERE (m.sender_id = u.id AND m.recipient_id = :me)
                    OR (m.sender_id = :me AND m.recipient_id = u.id)) AS last_msg
        FROM users u
        WHERE u.id != :me
        ORDER BY last_msg IS NULL, last_msg DESC, u.username
        """,
        {"me": user["id"]},
    ).fetchall()
    return [
        {
            "username": r["username"],
            "pub": r["public_key"],
            "last_seen": r["last_seen"],
            "online": manager.is_online(r["username"]),
            "unread": r["unread"],
        }
        for r in rows
    ]


@app.get("/api/messages/{peer_name}")
def history(
    peer_name: str,
    before: int | None = None,
    limit: int = Query(50, ge=1, le=100),
    user=Depends(current_user),
    conn=Depends(get_conn),
):
    peer = get_peer(conn, peer_name)
    rows = conn.execute(
        """
        SELECT m.id, u.username AS sender, m.iv, m.ct, m.created_at,
               m.delivered_at, m.read_at
        FROM messages m JOIN users u ON u.id = m.sender_id
        WHERE ((m.sender_id = :me AND m.recipient_id = :peer)
            OR (m.sender_id = :peer AND m.recipient_id = :me))
          AND (:before IS NULL OR m.id < :before)
        ORDER BY m.id DESC LIMIT :limit
        """,
        {"me": user["id"], "peer": peer["id"], "before": before, "limit": limit},
    ).fetchall()
    return [
        {
            "id": r["id"],
            "from": r["sender"],
            "iv": r["iv"],
            "ct": r["ct"],
            "ts": r["created_at"],
            "delivered": r["delivered_at"] is not None,
            "read": r["read_at"] is not None,
        }
        for r in reversed(rows)
    ]


# ---------- websocket: presence, typing, live messages ----------


class Manager:
    """Tracks open sockets per username. One user can have several tabs."""

    def __init__(self):
        self.sockets: dict[str, set[WebSocket]] = defaultdict(set)

    def is_online(self, username: str) -> bool:
        return bool(self.sockets.get(username))

    async def send_user(self, username: str, payload: dict) -> int:
        sent = 0
        for ws in list(self.sockets.get(username, ())):
            try:
                await ws.send_text(json.dumps(payload))
                sent += 1
            except Exception:
                self.sockets[username].discard(ws)
        return sent

    async def broadcast(self, payload: dict, skip: str | None = None):
        for name in list(self.sockets):
            if name != skip:
                await self.send_user(name, payload)


manager = Manager()


def utc_now_sql(conn) -> str:
    return conn.execute("SELECT datetime('now')").fetchone()[0]


def same_origin(ws: WebSocket) -> bool:
    origin = ws.headers.get("origin")
    host = ws.headers.get("host")
    if not origin or not host:
        return False
    return origin.split("://", 1)[-1] == host


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    # browsers don't apply same-origin rules to websockets, so check it ourselves
    if not same_origin(ws):
        await ws.close(code=4403)
        return
    conn = connect()
    try:
        user = user_from_token(conn, ws.cookies.get(COOKIE))
        if not user:
            await ws.close(code=4401)
            return
        await ws.accept()
        me, my_id = user["username"], user["id"]

        first_tab = not manager.is_online(me)
        manager.sockets[me].add(ws)
        if first_tab:
            await manager.broadcast(
                {"type": "presence", "user": me, "online": True}, skip=me
            )

        # anything sent while we were offline now counts as delivered
        pending = conn.execute(
            "SELECT m.id, u.username FROM messages m JOIN users u ON u.id = m.sender_id "
            "WHERE m.recipient_id = ? AND m.delivered_at IS NULL",
            (my_id,),
        ).fetchall()
        if pending:
            conn.execute(
                "UPDATE messages SET delivered_at = datetime('now') "
                "WHERE recipient_id = ? AND delivered_at IS NULL",
                (my_id,),
            )
            conn.commit()
            for row in pending:
                await manager.send_user(
                    row["username"],
                    {"type": "receipt", "id": row["id"], "status": "delivered"},
                )

        await ws.send_text(json.dumps({"type": "ready", "me": me}))

        while True:
            try:
                data = json.loads(await ws.receive_text())
            except json.JSONDecodeError:
                continue
            if not isinstance(data, dict):
                continue
            kind = data.get("type")
            to = str(data.get("to", "")).lower()

            if kind == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
                continue

            peer = conn.execute(
                "SELECT id, username FROM users WHERE username = ?", (to,)
            ).fetchone()
            if not peer or peer["id"] == my_id:
                continue

            if kind == "typing":
                await manager.send_user(
                    peer["username"],
                    {"type": "typing", "from": me, "state": bool(data.get("state"))},
                )

            elif kind == "msg":
                iv, ct = data.get("iv"), data.get("ct")
                if not (isinstance(iv, str) and isinstance(ct, str)):
                    continue
                if len(iv) > 32 or not ct or len(ct) > MAX_CT_LEN:
                    continue
                cur = conn.execute(
                    "INSERT INTO messages (sender_id, recipient_id, iv, ct) "
                    "VALUES (?, ?, ?, ?)",
                    (my_id, peer["id"], iv, ct),
                )
                msg_id = cur.lastrowid
                conn.commit()
                row = conn.execute(
                    "SELECT created_at FROM messages WHERE id = ?", (msg_id,)
                ).fetchone()
                payload = {
                    "type": "msg",
                    "id": msg_id,
                    "from": me,
                    "to": peer["username"],
                    "iv": iv,
                    "ct": ct,
                    "ts": row["created_at"],
                    "cid": data.get("cid"),
                }
                got = await manager.send_user(peer["username"], payload)
                delivered = got > 0
                if delivered:
                    conn.execute(
                        "UPDATE messages SET delivered_at = datetime('now') WHERE id = ?",
                        (msg_id,),
                    )
                    conn.commit()
                # echo to every tab of the sender so they all stay in sync
                await manager.send_user(me, {**payload, "delivered": delivered})

            elif kind == "read":
                rows = conn.execute(
                    "SELECT id FROM messages WHERE sender_id = ? AND recipient_id = ? "
                    "AND read_at IS NULL",
                    (peer["id"], my_id),
                ).fetchall()
                if rows:
                    conn.execute(
                        "UPDATE messages SET read_at = datetime('now'), "
                        "delivered_at = COALESCE(delivered_at, datetime('now')) "
                        "WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL",
                        (peer["id"], my_id),
                    )
                    conn.commit()
                    await manager.send_user(
                        peer["username"],
                        {
                            "type": "read",
                            "by": me,
                            "ids": [r["id"] for r in rows],
                        },
                    )
                # other tabs of mine should clear their unread badge too
                await manager.send_user(me, {"type": "read-sync", "peer": to})
    except WebSocketDisconnect:
        pass
    except Exception:
        # bad frame or db hiccup: drop this socket, don't take the server down
        log.exception("websocket error")
    finally:
        try:
            username = locals().get("me")
            if username:
                manager.sockets[username].discard(ws)
                if not manager.sockets[username]:
                    manager.sockets.pop(username, None)
                    now = utc_now_sql(conn)
                    conn.execute(
                        "UPDATE users SET last_seen = ? WHERE id = ?",
                        (now, my_id),
                    )
                    conn.commit()
                    await manager.broadcast(
                        {
                            "type": "presence",
                            "user": username,
                            "online": False,
                            "last_seen": now,
                        }
                    )
        finally:
            conn.close()


# ---------- pages ----------


@app.get("/")
@app.get("/index.html")
def index(session: str | None = Cookie(default=None), conn=Depends(get_conn)):
    # redirect on the server so a logged-out visitor never sees the chat flash up
    if not user_from_token(conn, session):
        return RedirectResponse("/login.html", status_code=302)
    return FileResponse(WEB_DIR / "index.html")


app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
