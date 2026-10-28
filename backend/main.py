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


# ---------- pages ----------


@app.get("/")
@app.get("/index.html")
def index(session: str | None = Cookie(default=None), conn=Depends(get_conn)):
    # redirect on the server so a logged-out visitor never sees the chat flash up
    if not user_from_token(conn, session):
        return RedirectResponse("/login.html", status_code=302)
    return FileResponse(WEB_DIR / "index.html")


app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
