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
