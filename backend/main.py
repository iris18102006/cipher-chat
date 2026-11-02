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
