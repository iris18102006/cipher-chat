"""Chat themes: how one conversation looks for you.

Each person picks a look for each chat (a 1:1 chat or a group). It's stored per
person, so you can't change how a chat looks for anyone else, and the person on
the other side never learns what you picked. It's only colours and a pattern
from fixed lists, never free text, so there's nothing to inject.

Imported by main.py at the very bottom, after everything it needs is defined.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .groups import get_group
from .main import ACCENT_RE, current_user, get_conn, get_peer

router = APIRouter()

# the names have to match the .ct-* classes in web/chat-themes.css
CHAT_THEMES = (
    "classic", "emo", "kawaii", "neon", "forest",
    "sunset", "gothic", "terminal", "ocean", "midnight",
)
CHAT_PATTERNS = ("none", "dots", "grid", "hearts", "stars")
DEFAULT = {"theme": "classic", "accent": "", "pattern": "none"}


class ChatThemeBody(BaseModel):
    theme: str = "classic"
    accent: str = ""
    pattern: str = "none"


def clean(body: ChatThemeBody) -> dict:
    if body.theme not in CHAT_THEMES:
        raise HTTPException(400, "unknown theme")
    if body.pattern not in CHAT_PATTERNS:
        raise HTTPException(400, "unknown pattern")
    accent = body.accent.strip()
    if accent and not ACCENT_RE.match(accent):
        raise HTTPException(400, "accent must look like #ff9933")
    return {"theme": body.theme, "accent": accent.lower(), "pattern": body.pattern}


def save(conn, user_id: int, kind: str, target_id: int, look: dict) -> dict:
    if look == DEFAULT:
        # back to the normal look, so there's nothing to remember
        conn.execute(
            "DELETE FROM chat_themes WHERE user_id = ? AND kind = ? AND target_id = ?",
            (user_id, kind, target_id),
        )
    else:
        conn.execute(
            "INSERT INTO chat_themes (user_id, kind, target_id, theme, accent, pattern) "
            "VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT (user_id, kind, target_id) DO UPDATE SET "
            "theme = excluded.theme, accent = excluded.accent, pattern = excluded.pattern",
            (user_id, kind, target_id, look["theme"], look["accent"], look["pattern"]),
        )
    conn.commit()
    return look
