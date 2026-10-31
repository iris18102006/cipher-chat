import base64
import hashlib
import io
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
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps, UnidentifiedImageError
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

# pictures: one profile picture plus a small gallery of photos / gifs
IMAGE_TYPES = {"PNG": "image/png", "JPEG": "image/jpeg", "GIF": "image/gif", "WEBP": "image/webp"}
MAX_PHOTOS = 12
MAX_STICKERS = 8
MAX_AVATAR_UPLOAD = 5 * 1024 * 1024
MAX_PHOTO_UPLOAD = 4 * 1024 * 1024
MAX_SIDE = 8000  # pixels
MAX_PIXELS = 25_000_000
MAX_FRAMES = 300
AVATAR_PX = 320
PHOTO_PX = 1600
CAPTION_LIMIT = 60

# Safe MySpace-style profile customization. Users can combine whitelisted
# visual options, but never submit arbitrary CSS/HTML.
CUSTOM_COLORS = ("page", "card", "text", "head_a", "head_b", "head_text", "border")
CUSTOM_CHOICES = {
    "font": (
        "verdana", "comic", "georgia", "courier", "trebuchet", "times", "impact",
        "arial", "palatino", "lucida", "script",
    ),
    "pattern": ("none", "dots", "stripes", "checks", "grid", "diagonal", "stars", "hearts"),
    "border_style": ("solid", "dashed", "dotted", "double", "ridge", "groove"),
    "name_effect": ("none", "glow", "shadow", "rainbow"),
    "avatar_shape": ("circle", "rounded", "square", "diamond", "hexagon"),
    "bg_mode": ("tile", "cover", "center"),
}
CUSTOM_RANGES = {"border_width": (0, 6), "radius": (0, 24)}
CUSTOM_FLAGS = ("marquee",)

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


class CommentBody(BaseModel):
    body: str


class CaptionBody(BaseModel):
    caption: str


class StickerBody(BaseModel):
    img: int  # id of one of your own gallery pictures
    x: float  # centre, % of the profile's width
    y: float  # centre, % of the profile's height
    w: float  # width, % of the profile's width
    r: int = 0  # rotation in degrees


class ProfileBody(BaseModel):
    # every field is optional so the editor can save just what changed
    display_name: str | None = None
    mood: str | None = None
    headline: str | None = None
    about_me: str | None = None
    interests: str | None = None
    location: str | None = None
    song: str | None = None
    theme: str | None = None
    accent: str | None = None
    custom: dict[str, str | int | bool] | None = None
    top_friends: list[str] | None = None
    bg_image: int | None = None  # a gallery picture id, 0 clears it
    stickers: list[StickerBody] | None = None


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


def clean_custom(value: dict) -> dict:
    """Validate custom profile styling without accepting arbitrary CSS."""
    if not isinstance(value, dict):
        raise HTTPException(400, "custom style must be an object")
    out: dict = {}
    for key, val in value.items():
        if key in CUSTOM_COLORS:
            if not isinstance(val, str) or not ACCENT_RE.fullmatch(val):
                raise HTTPException(400, f"{key.replace('_', ' ')} must be a colour like #ff9933")
            out[key] = val.lower()
        elif key in CUSTOM_CHOICES:
            if not isinstance(val, str) or val not in CUSTOM_CHOICES[key]:
                raise HTTPException(400, f"unknown {key.replace('_', ' ')}")
            out[key] = val
        elif key in CUSTOM_RANGES:
            lo, hi = CUSTOM_RANGES[key]
            if isinstance(val, bool) or not isinstance(val, int) or not lo <= val <= hi:
                raise HTTPException(400, f"{key.replace('_', ' ')} must be {lo} to {hi}")
            out[key] = val
        elif key in CUSTOM_FLAGS:
            if not isinstance(val, bool):
                raise HTTPException(400, f"{key} must be on or off")
            out[key] = val
        else:
            raise HTTPException(400, f"unknown style option: {str(key)[:30]}")
    return out


def custom_from_row(row) -> dict:
    try:
        value = json.loads(row["custom_theme"])
        return clean_custom(value)
    except (TypeError, ValueError, HTTPException, KeyError, AttributeError):
        return {}


# ---------- pictures ----------


def avatar_url(image_id) -> str:
    return f"/api/img/{image_id}" if image_id else ""


async def read_body(request: Request, limit: int) -> bytes:
    """Read an upload, giving up as soon as it goes over the limit."""
    too_big = HTTPException(413, f"that file is too big (max {limit // (1024 * 1024)} MB)")
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > limit:
        raise too_big
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise too_big
        chunks.append(chunk)
    return b"".join(chunks)


def process_image(raw: bytes, kind: str) -> dict:
    """Check that an upload really is a png/jpg/gif/webp and make it safe to serve.

    Still pictures (and every profile picture) are decoded and saved again as a
    resized webp, which also throws away any hidden data like GPS in the photo.
    Animated gifs are kept as they are so they keep moving, after checking them.
    """
    try:
        img = Image.open(io.BytesIO(raw))
        fmt = img.format
        if fmt not in IMAGE_TYPES:
            raise HTTPException(400, "use a png, jpg, gif or webp picture")
        w, h = img.size
        if w < 1 or h < 1 or w > MAX_SIDE or h > MAX_SIDE or w * h > MAX_PIXELS:
            raise HTTPException(400, f"that picture is too big (max {MAX_SIDE}px on a side)")
        frames = getattr(img, "n_frames", 1)
        if frames > 1 and fmt in ("GIF", "WEBP") and kind == "photo":
            if frames > MAX_FRAMES:
                raise HTTPException(400, f"that gif has too many frames (max {MAX_FRAMES})")
            img.seek(frames - 1)  # a broken file fails here instead of in somebody's browser
            img.load()
            return {"mime": IMAGE_TYPES[fmt], "data": raw, "width": w, "height": h, "animated": 1}
        img.seek(0)
        img = ImageOps.exif_transpose(img)
        has_alpha = img.mode in ("RGBA", "LA", "PA") or "transparency" in img.info
        img = img.convert("RGBA" if has_alpha else "RGB")
        if kind == "avatar":
            img = ImageOps.fit(img, (AVATAR_PX, AVATAR_PX), Image.Resampling.LANCZOS)
        else:
            img.thumbnail((PHOTO_PX, PHOTO_PX), Image.Resampling.LANCZOS)
        out = io.BytesIO()
        img.save(out, "WEBP", quality=85)
        return {
            "mime": "image/webp", "data": out.getvalue(),
            "width": img.width, "height": img.height, "animated": 0,
        }
    except HTTPException:
        raise
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError, SyntaxError, EOFError):
        raise HTTPException(400, "that doesn't look like a picture we can read")


def own_photo(conn, user_id: int, image_id: int):
    row = conn.execute(
        "SELECT id FROM images WHERE id = ? AND owner_id = ? AND kind = 'photo'",
        (image_id, user_id),
    ).fetchone()
    if not row:
        raise HTTPException(400, "that picture isn't in your gallery")
    return row


def clean_stickers(conn, user_id: int, stickers: list[StickerBody]) -> list[dict]:
    if len(stickers) > MAX_STICKERS:
        raise HTTPException(400, f"you can only place {MAX_STICKERS} stickers")
    out = []
    for s in stickers:
        own_photo(conn, user_id, s.img)
        if not (0 <= s.x <= 100 and 0 <= s.y <= 100):
            raise HTTPException(400, "stickers have to stay on the page")
        if not 4 <= s.w <= 45:
            raise HTTPException(400, "sticker size must be 4 to 45")
        if not -45 <= s.r <= 45:
            raise HTTPException(400, "sticker tilt must be -45 to 45")
        out.append({"img": s.img, "x": round(s.x, 2), "y": round(s.y, 2), "w": round(s.w, 2), "r": s.r})
    return out


def media_for(conn, row) -> dict:
    """Profile picture, gallery, background and stickers for one user row
    (needs id, avatar_id, bg_image_id and stickers)."""
    photos = conn.execute(
        "SELECT id, caption, width, height, animated FROM images "
        "WHERE owner_id = ? AND kind = 'photo' ORDER BY id",
        (row["id"],),
    ).fetchall()
    ids = {r["id"] for r in photos}
    try:
        placed = json.loads(row["stickers"])
    except (TypeError, ValueError):
        placed = []
    stickers = []
    for st in placed if isinstance(placed, list) else []:
        # a sticker whose picture was deleted just disappears
        if isinstance(st, dict) and st.get("img") in ids:
            stickers.append({**st, "url": avatar_url(st["img"])})
    bg = row["bg_image_id"] if row["bg_image_id"] in ids else 0
    return {
        "avatar": avatar_url(row["avatar_id"]),
        "photos": [
            {
                "id": r["id"], "url": avatar_url(r["id"]), "caption": r["caption"],
                "width": r["width"], "height": r["height"], "animated": bool(r["animated"]),
            }
            for r in photos
        ],
        "stickers": stickers,
        "bg_image": bg,
        "bg_url": avatar_url(bg),
    }


def media_response(conn, user_id: int) -> dict:
    row = conn.execute(
        "SELECT id, avatar_id, bg_image_id, stickers FROM users WHERE id = ?", (user_id,)
    ).fetchone()
    return media_for(conn, row)


def purge_image_refs(conn, user_id: int, image_id: int):
    """Take a deleted picture out of the background and the stickers."""
    row = conn.execute(
        "SELECT bg_image_id, stickers FROM users WHERE id = ?", (user_id,)
    ).fetchone()
    try:
        placed = [st for st in json.loads(row["stickers"]) if st.get("img") != image_id]
    except (TypeError, ValueError, AttributeError):
        placed = []
    bg = None if row["bg_image_id"] == image_id else row["bg_image_id"]
    conn.execute(
        "UPDATE users SET bg_image_id = ?, stickers = ? WHERE id = ?",
        (bg, json.dumps(placed, separators=(",", ":")), user_id),
    )


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
def me(user=Depends(current_user), conn=Depends(get_conn)):
    row = conn.execute(
        "SELECT display_name, avatar_id FROM users WHERE id = ?", (user["id"],)
    ).fetchone()
    return {
        "username": user["username"],
        "display_name": row["display_name"],
        "avatar": avatar_url(row["avatar_id"]),
    }


# ---------- profiles ----------

PROFILE_COLUMNS = (
    "id, username, display_name, mood, headline, about_me, interests, "
    "location, song, avatar_id, bg_image_id, stickers, theme, accent, custom_theme, "
    "top_friends, created_at, last_seen"
)


def profile_dict(row, viewer_id: int) -> dict:
    return {
        "username": row["username"],
        "display_name": row["display_name"],
        "mood": row["mood"],
        "headline": row["headline"],
        "about_me": row["about_me"],
        "interests": row["interests"],
        "location": row["location"],
        "song": row["song"],
        "avatar": avatar_url(row["avatar_id"]),
        "theme": row["theme"],
        "accent": row["accent"],
        "custom": custom_from_row(row),
        "joined": row["created_at"],
        "last_seen": row["last_seen"],
        "online": manager.is_online(row["username"]),
        "me": row["id"] == viewer_id,
    }


def top_friend_names(conn, user_id: int, names: list[str]) -> list[str]:
    """Only real friends can be in your top friends, in the order you picked."""
    picked: list[str] = []
    allowed = friend_ids(conn, user_id)
    for name in names:
        name = name.strip().lower()
        if name in picked:
            continue
        row = conn.execute("SELECT id FROM users WHERE username = ?", (name,)).fetchone()
        if not row or row["id"] not in allowed:
            raise HTTPException(400, f"{name} isn't one of your friends")
        picked.append(name)
    if len(picked) > MAX_TOP_FRIENDS:
        raise HTTPException(400, f"you can only pick {MAX_TOP_FRIENDS} top friends")
    return picked


def wall_for(conn, profile_id: int, viewer_id: int) -> list[dict]:
    rows = conn.execute(
        """
        SELECT c.id, c.author_id, c.body, c.created_at,
               u.username, u.display_name, u.avatar_id
        FROM profile_comments c JOIN users u ON u.id = c.author_id
        WHERE c.profile_id = ?
        ORDER BY c.id DESC LIMIT 30
        """,
        (profile_id,),
    ).fetchall()
    out = []
    for r in rows:
        if r["author_id"] != viewer_id and blocked_either_way(conn, viewer_id, r["author_id"]):
            continue
        out.append({
            "id": r["id"], "username": r["username"],
            "display_name": r["display_name"], "avatar": avatar_url(r["avatar_id"]),
            "body": r["body"], "created_at": r["created_at"],
            "mine": r["author_id"] == viewer_id,
        })
    return out


def top_friends_for(conn, row, viewer_id: int) -> list[dict]:
    try:
        names = json.loads(row["top_friends"])
    except (TypeError, ValueError):
        return []
    owner_friends = friend_ids(conn, row["id"])
    out = []
    for name in names:
        f = conn.execute(
            "SELECT id, username, display_name, avatar_id FROM users WHERE username = ?",
            (name,),
        ).fetchone()
        # drop people who aren't friends any more, or who have a block with the viewer
        if not f or f["id"] not in owner_friends:
            continue
        if f["id"] != viewer_id and blocked_either_way(conn, viewer_id, f["id"]):
            continue
        out.append(
            {
                "username": f["username"],
                "display_name": f["display_name"],
                "avatar": avatar_url(f["avatar_id"]),
            }
        )
    return out


@app.get("/api/profile/{username}")
def get_profile(username: str, user=Depends(current_user), conn=Depends(get_conn)):
    row = conn.execute(
        f"SELECT {PROFILE_COLUMNS} FROM users WHERE username = ?", (username.lower(),)
    ).fetchone()
    if not row or i_blocked(conn, row["id"], user["id"]):
        raise HTTPException(404, "no such user")
    out = profile_dict(row, user["id"])
    out["blocked"] = i_blocked(conn, user["id"], row["id"])
    out["top_friends"] = top_friends_for(conn, row, user["id"])
    theirs = friend_ids(conn, row["id"])
    out["friend_count"] = len(theirs)
    if row["id"] != user["id"]:
        out["friend"] = friend_status(conn, user["id"], row["id"])
        out["mutual_friends"] = len(theirs & friend_ids(conn, user["id"]))
        # one row per visitor, so refreshing doesn't inflate the counter
        conn.execute(
            "INSERT INTO profile_visits (profile_id, visitor_id) VALUES (?, ?) "
            "ON CONFLICT (profile_id, visitor_id) DO UPDATE SET last_visit = CURRENT_TIMESTAMP",
            (row["id"], user["id"]),
        )
        conn.commit()
    out["visitors"] = conn.execute(
        "SELECT COUNT(*) FROM profile_visits WHERE profile_id = ?", (row["id"],)
    ).fetchone()[0]
    out["wall"] = wall_for(conn, row["id"], user["id"])
    out.update(media_for(conn, row))
    return out


@app.post("/api/profile/{username}/wall")
def post_wall_comment(username: str, body: CommentBody, user=Depends(current_user), conn=Depends(get_conn)):
    profile = conn.execute("SELECT id, username FROM users WHERE username = ?", (username.lower(),)).fetchone()
    if not profile or blocked_either_way(conn, user["id"], profile["id"]):
        raise HTTPException(404, "no such user")
    text = clean_text(body.body, 300, "comment", multiline=True)
    if not text:
        raise HTTPException(400, "comment can't be empty")
    cur = conn.execute(
        "INSERT INTO profile_comments (profile_id, author_id, body) VALUES (?, ?, ?)",
        (profile["id"], user["id"], text),
    )
    conn.commit()
    return {"id": cur.lastrowid, "ok": True}


@app.delete("/api/profile/{username}/wall/{comment_id}")
def delete_wall_comment(username: str, comment_id: int, user=Depends(current_user), conn=Depends(get_conn)):
    profile = conn.execute("SELECT id FROM users WHERE username = ?", (username.lower(),)).fetchone()
    if not profile:
        raise HTTPException(404, "no such user")
    row = conn.execute(
        "SELECT author_id FROM profile_comments WHERE id = ? AND profile_id = ?",
        (comment_id, profile["id"]),
    ).fetchone()
    if not row:
        raise HTTPException(404, "no such comment")
    if user["id"] not in (row["author_id"], profile["id"]):
        raise HTTPException(403, "you can't delete that comment")
    conn.execute("DELETE FROM profile_comments WHERE id = ?", (comment_id,))
    conn.commit()
    return {"ok": True}


@app.put("/api/profile")
def put_profile(body: ProfileBody, user=Depends(current_user), conn=Depends(get_conn)):
    changes = body.model_dump(exclude_unset=True)
    updates: dict = {}
    for field, value in changes.items():
        if value is None:
            continue
        if field in PROFILE_LIMITS:
            updates[field] = clean_text(
                value, PROFILE_LIMITS[field], field, multiline=field == "about_me"
            )
        elif field == "theme":
            if value not in THEMES:
                raise HTTPException(400, "unknown theme")
            updates[field] = value
        elif field == "accent":
            if value and not ACCENT_RE.fullmatch(value):
                raise HTTPException(400, "accent must look like #ff9933")
            updates[field] = value.lower()
        elif field == "custom":
            updates["custom_theme"] = json.dumps(clean_custom(value), separators=(",", ":"))
        elif field == "top_friends":
            updates[field] = json.dumps(top_friend_names(conn, user["id"], value))
        elif field == "bg_image":
            if value:
                own_photo(conn, user["id"], value)
            updates["bg_image_id"] = value or None
        elif field == "stickers":
            updates["stickers"] = json.dumps(
                clean_stickers(conn, user["id"], body.stickers), separators=(",", ":")
            )
    if updates:
        # column names come from the fixed set above, never from the request
        sets = ", ".join(f"{col} = ?" for col in updates)
        conn.execute(
            f"UPDATE users SET {sets} WHERE id = ?", (*updates.values(), user["id"])
        )
        conn.commit()
    return get_profile(user["username"], user, conn)


# ---------- pictures: profile picture, gallery, serving ----------


@app.get("/api/img/{image_id}")
def get_image(image_id: int, user=Depends(current_user), conn=Depends(get_conn)):
    row = conn.execute(
        "SELECT owner_id, mime, data FROM images WHERE id = ?", (image_id,)
    ).fetchone()
    # someone who blocked you doesn't show you their pictures either
    if not row or (row["owner_id"] != user["id"] and i_blocked(conn, row["owner_id"], user["id"])):
        raise HTTPException(404, "no such picture")
    return Response(
        content=bytes(row["data"]),
        media_type=row["mime"],
        headers={
            "Cache-Control": "private, max-age=3600",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
        },
    )


@app.put("/api/me/avatar")
async def set_avatar(request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    raw = await read_body(request, MAX_AVATAR_UPLOAD)
    img = await run_in_threadpool(process_image, raw, "avatar")
    old = conn.execute("SELECT avatar_id FROM users WHERE id = ?", (user["id"],)).fetchone()["avatar_id"]
    cur = conn.execute(
        "INSERT INTO images (owner_id, kind, mime, data, width, height, animated) "
        "VALUES (?, 'avatar', ?, ?, ?, ?, ?)",
        (user["id"], img["mime"], img["data"], img["width"], img["height"], img["animated"]),
    )
    conn.execute("UPDATE users SET avatar_id = ? WHERE id = ?", (cur.lastrowid, user["id"]))
    if old:
        conn.execute("DELETE FROM images WHERE id = ? AND owner_id = ?", (old, user["id"]))
    conn.commit()
    return media_response(conn, user["id"])


@app.delete("/api/me/avatar")
def remove_avatar(user=Depends(current_user), conn=Depends(get_conn)):
    old = conn.execute("SELECT avatar_id FROM users WHERE id = ?", (user["id"],)).fetchone()["avatar_id"]
    conn.execute("UPDATE users SET avatar_id = NULL WHERE id = ?", (user["id"],))
    if old:
        conn.execute("DELETE FROM images WHERE id = ? AND owner_id = ?", (old, user["id"]))
    conn.commit()
    return media_response(conn, user["id"])


@app.post("/api/me/photos")
async def add_photo(request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    have = conn.execute(
        "SELECT COUNT(*) FROM images WHERE owner_id = ? AND kind = 'photo'", (user["id"],)
    ).fetchone()[0]
    if have >= MAX_PHOTOS:
        raise HTTPException(400, f"you can have up to {MAX_PHOTOS} pictures, remove one first")
    raw = await read_body(request, MAX_PHOTO_UPLOAD)
    img = await run_in_threadpool(process_image, raw, "photo")
    conn.execute(
        "INSERT INTO images (owner_id, kind, mime, data, width, height, animated) "
        "VALUES (?, 'photo', ?, ?, ?, ?, ?)",
        (user["id"], img["mime"], img["data"], img["width"], img["height"], img["animated"]),
    )
    conn.commit()
    return media_response(conn, user["id"])


@app.patch("/api/me/photos/{image_id}")
def caption_photo(image_id: int, body: CaptionBody, user=Depends(current_user), conn=Depends(get_conn)):
    own_photo(conn, user["id"], image_id)
    caption = clean_text(body.caption, CAPTION_LIMIT, "caption")
    conn.execute("UPDATE images SET caption = ? WHERE id = ?", (caption, image_id))
    conn.commit()
    return media_response(conn, user["id"])


@app.delete("/api/me/photos/{image_id}")
def delete_photo(image_id: int, user=Depends(current_user), conn=Depends(get_conn)):
    own_photo(conn, user["id"], image_id)
    conn.execute("DELETE FROM images WHERE id = ?", (image_id,))
    purge_image_refs(conn, user["id"], image_id)
    conn.commit()
    return media_response(conn, user["id"])


# ---------- friends ----------


def friend_status(conn, me_id: int, other_id: int) -> str:
    """none | friends | outgoing (I asked) | incoming (they asked me)"""
    row = conn.execute(
        "SELECT requester_id, status FROM friendships "
        "WHERE (requester_id = :a AND addressee_id = :b) "
        "   OR (requester_id = :b AND addressee_id = :a)",
        {"a": me_id, "b": other_id},
    ).fetchone()
    if not row:
        return "none"
    if row["status"] == "accepted":
        return "friends"
    return "outgoing" if row["requester_id"] == me_id else "incoming"


def friend_ids(conn, user_id: int) -> set[int]:
    rows = conn.execute(
        "SELECT CASE WHEN requester_id = :me THEN addressee_id ELSE requester_id END "
        "FROM friendships WHERE status = 'accepted' "
        "AND (requester_id = :me OR addressee_id = :me)",
        {"me": user_id},
    ).fetchall()
    return {r[0] for r in rows}


def other_user(conn, user, username: str):
    peer = get_peer(conn, username)
    if peer["id"] == user["id"]:
        raise HTTPException(400, "that's you")
    return peer


@app.get("/api/friends")
def list_friends(user=Depends(current_user), conn=Depends(get_conn)):
    rows = conn.execute(
        """
        SELECT u.username, u.display_name, u.avatar_id, f.status,
               f.requester_id = :me AS mine
        FROM friendships f
        JOIN users u ON u.id = CASE WHEN f.requester_id = :me
                                    THEN f.addressee_id ELSE f.requester_id END
        WHERE f.requester_id = :me OR f.addressee_id = :me
        ORDER BY u.username
        """,
        {"me": user["id"]},
    ).fetchall()
    out = {"friends": [], "incoming": [], "outgoing": []}
    for r in rows:
        item = {
            "username": r["username"],
            "display_name": r["display_name"],
            "avatar": avatar_url(r["avatar_id"]),
        }
        if r["status"] == "accepted":
            out["friends"].append(item)
        elif r["mine"]:
            out["outgoing"].append(item)
        else:
            out["incoming"].append(item)
    return out


@app.post("/api/friends/{username}")
async def add_friend(username: str, user=Depends(current_user), conn=Depends(get_conn)):
    peer = other_user(conn, user, username)
    if blocked_either_way(conn, user["id"], peer["id"]):
        raise HTTPException(403, "you can't send a friend request to this user")
    status = friend_status(conn, user["id"], peer["id"])
    if status == "incoming":
        # they already asked me, so asking back just means yes
        return await accept_friend(username, user, conn)
    if status == "none":
        conn.execute(
            "INSERT INTO friendships (requester_id, addressee_id) VALUES (?, ?)",
            (user["id"], peer["id"]),
        )
        conn.commit()
        status = "outgoing"
        await manager.send_user(
            peer["username"], {"type": "social", "event": "request", "from": user["username"]}
        )
    return {"status": status}


@app.post("/api/friends/{username}/accept")
async def accept_friend(username: str, user=Depends(current_user), conn=Depends(get_conn)):
    peer = other_user(conn, user, username)
    cur = conn.execute(
        "UPDATE friendships SET status = 'accepted' "
        "WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'",
        (peer["id"], user["id"]),
    )
    conn.commit()
    if cur.rowcount == 0 and friend_status(conn, user["id"], peer["id"]) != "friends":
        raise HTTPException(404, "no friend request from that user")
    if cur.rowcount:
        await manager.send_user(
            peer["username"], {"type": "social", "event": "accepted", "from": user["username"]}
        )
    return {"status": "friends"}


@app.delete("/api/friends/{username}")
async def remove_friend(username: str, user=Depends(current_user), conn=Depends(get_conn)):
    """Unfriend, cancel a request I sent, or decline one I got."""
    peer = other_user(conn, user, username)
    conn.execute(
        "DELETE FROM friendships WHERE (requester_id = :a AND addressee_id = :b) "
        "OR (requester_id = :b AND addressee_id = :a)",
        {"a": user["id"], "b": peer["id"]},
    )
    conn.commit()
    await manager.send_user(
        peer["username"], {"type": "social", "event": "removed", "from": user["username"]}
    )
    return {"status": "none"}


# ---------- blocking ----------


def i_blocked(conn, me_id: int, other_id: int) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?",
            (me_id, other_id),
        ).fetchone()
        is not None
    )


def blocked_either_way(conn, a: int, b: int) -> bool:
    return i_blocked(conn, a, b) or i_blocked(conn, b, a)


def blocked_names(conn, user_id: int) -> set[str]:
    """Usernames I blocked plus usernames that blocked me."""
    rows = conn.execute(
        "SELECT username FROM users WHERE id IN ("
        "SELECT blocked_id FROM blocks WHERE blocker_id = :me "
        "UNION SELECT blocker_id FROM blocks WHERE blocked_id = :me)",
        {"me": user_id},
    ).fetchall()
    return {r["username"] for r in rows}


async def notify_block_change(me: str, other: str):
    """Tell my other tabs, and quietly nudge the other person to refresh their
    buddy list (their view of my presence just changed). Nothing says who blocked."""
    await manager.send_user(me, {"type": "social", "event": "refresh", "from": other})
    await manager.send_user(other, {"type": "social", "event": "refresh", "from": me})


@app.get("/api/blocks")
def list_blocks(user=Depends(current_user), conn=Depends(get_conn)):
    rows = conn.execute(
        "SELECT u.username, u.display_name, u.avatar_id FROM blocks b "
        "JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? "
        "ORDER BY u.username",
        (user["id"],),
    ).fetchall()
    return [
        {
            "username": r["username"],
            "display_name": r["display_name"],
            "avatar": avatar_url(r["avatar_id"]),
        }
        for r in rows
    ]


@app.post("/api/blocks/{username}")
async def block_user(username: str, user=Depends(current_user), conn=Depends(get_conn)):
    peer = other_user(conn, user, username)
    conn.execute(
        "INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)",
        (user["id"], peer["id"]),
    )
    # blocking someone also ends the friendship / any pending request
    conn.execute(
        "DELETE FROM friendships WHERE (requester_id = :a AND addressee_id = :b) "
        "OR (requester_id = :b AND addressee_id = :a)",
        {"a": user["id"], "b": peer["id"]},
    )
    conn.commit()
    await notify_block_change(user["username"], peer["username"])
    return {"blocked": True}


@app.delete("/api/blocks/{username}")
async def unblock_user(username: str, user=Depends(current_user), conn=Depends(get_conn)):
    peer = other_user(conn, user, username)
    conn.execute(
        "DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?",
        (user["id"], peer["id"]),
    )
    conn.commit()
    await notify_block_change(user["username"], peer["username"])
    return {"blocked": False}


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
        SELECT u.id, u.username, u.public_key, u.last_seen,
               u.display_name, u.avatar_id, u.mood,
               (SELECT COUNT(*) FROM messages m
                 WHERE m.sender_id = u.id AND m.recipient_id = :me
                   AND m.read_at IS NULL AND m.hidden = 0) AS unread,
               (SELECT MAX(m.id) FROM messages m
                 WHERE (m.sender_id = u.id AND m.recipient_id = :me AND m.hidden = 0)
                    OR (m.sender_id = :me AND m.recipient_id = u.id)) AS last_msg
        FROM users u
        WHERE u.id != :me
          AND (
              EXISTS (SELECT 1 FROM friendships f
                      WHERE (f.requester_id = u.id AND f.addressee_id = :me)
                         OR (f.requester_id = :me AND f.addressee_id = u.id))
              OR EXISTS (SELECT 1 FROM blocks b
                         WHERE b.blocker_id = :me AND b.blocked_id = u.id)
          )
        ORDER BY last_msg IS NULL, last_msg DESC, u.username
        """,
        {"me": user["id"]},
    ).fetchall()
    mine = {
        r[0]
        for r in conn.execute(
            "SELECT blocked_id FROM blocks WHERE blocker_id = ?", (user["id"],)
        )
    }
    theirs = {
        r[0]
        for r in conn.execute(
            "SELECT blocker_id FROM blocks WHERE blocked_id = ?", (user["id"],)
        )
    }
    out = []
    for r in rows:
        # someone who blocked me looks permanently offline, with no last seen
        hidden = r["id"] in theirs
        out.append(
            {
                "username": r["username"],
                "display_name": r["display_name"],
                "avatar": avatar_url(r["avatar_id"]),
                "mood": r["mood"],
                "pub": r["public_key"],
                "last_seen": None if hidden else r["last_seen"],
                "online": False if hidden else manager.is_online(r["username"]),
                "unread": r["unread"],
                "friend": friend_status(conn, user["id"], r["id"]),
                "blocked": r["id"] in mine,
            }
        )
    return out


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
          AND NOT (m.recipient_id = :me AND m.hidden = 1)
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


def presence_audience(conn, user_id: int) -> set[str]:
    """Only users with a social relationship should receive presence events."""
    rows = conn.execute(
        """
        SELECT username FROM users WHERE id IN (
            SELECT addressee_id FROM friendships WHERE requester_id = :me
            UNION SELECT requester_id FROM friendships WHERE addressee_id = :me
            UNION SELECT blocker_id FROM blocks WHERE blocked_id = :me
        )
        """,
        {"me": user_id},
    ).fetchall()
    return {r["username"] for r in rows}


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

    async def send_many(self, usernames: set[str], payload: dict):
        for name in usernames:
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
            await manager.send_many(
                presence_audience(conn, my_id) - blocked_names(conn, my_id) - {me},
                {"type": "presence", "user": me, "online": True},
            )

        # anything sent while we were offline now counts as delivered
        pending = conn.execute(
            "SELECT m.id, u.username FROM messages m JOIN users u ON u.id = m.sender_id "
            "WHERE m.recipient_id = ? AND m.delivered_at IS NULL AND m.hidden = 0",
            (my_id,),
        ).fetchall()
        if pending:
            conn.execute(
                "UPDATE messages SET delivered_at = datetime('now') "
                "WHERE recipient_id = ? AND delivered_at IS NULL AND hidden = 0",
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
                if blocked_either_way(conn, my_id, peer["id"]):
                    continue
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
                if i_blocked(conn, my_id, peer["id"]):
                    continue  # you blocked them, unblock to talk again
                # if they blocked me the message is kept (my history stays whole)
                # but hidden from them, and I'm not told
                hidden = 1 if i_blocked(conn, peer["id"], my_id) else 0
                cur = conn.execute(
                    "INSERT INTO messages (sender_id, recipient_id, iv, ct, hidden) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (my_id, peer["id"], iv, ct, hidden),
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
                got = 0 if hidden else await manager.send_user(peer["username"], payload)
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
                    "AND read_at IS NULL AND hidden = 0",
                    (peer["id"], my_id),
                ).fetchall()
                if rows:
                    conn.execute(
                        "UPDATE messages SET read_at = datetime('now'), "
                        "delivered_at = COALESCE(delivered_at, datetime('now')) "
                        "WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL "
                        "AND hidden = 0",
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
                    await manager.send_many(
                        presence_audience(conn, my_id) - blocked_names(conn, my_id),
                        {
                            "type": "presence",
                            "user": username,
                            "online": False,
                            "last_seen": now,
                        },
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
