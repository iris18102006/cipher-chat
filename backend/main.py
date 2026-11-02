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

# messages from someone whose friend request you haven't accepted yet
MESSAGE_POLICIES = ("allow", "ask", "wait")
MAX_HELD = 3  # how many messages someone can leave waiting while you decide
HELD = 2  # messages.hidden = 2 means "waiting for the friend request to be accepted"

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
        # bundled fonts (web/fonts), the ones shown in the editor
        "verdana", "nunito", "comic", "lora", "playfair", "courier", "typewriter",
        "terminal", "pixel", "impact", "script", "gothic",
        # older choices, still valid so profiles that use them keep working
        "arial", "trebuchet", "georgia", "times", "palatino", "lucida",
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


class SettingsBody(BaseModel):
    message_policy: str | None = None


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
