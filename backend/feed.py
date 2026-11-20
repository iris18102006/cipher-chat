"""The feed: posts that you and your friends can see.

Posts are plain text (never rendered as html) with up to four pictures, or a video, and a song.
Like everything on a profile they are not encrypted: only messages are, because the server has to
be able to look at what gets posted (see moderation.py).

Who sees a post is the author's choice, per post: all friends, close friends only, or only the
author (postaccess.py explains the rules). Nobody sees anything from somebody they have a block with.

A repost is a post of its own (with an optional note) that points at the original. Reposting never
opens the original up to more people: a friend of yours who isn't a friend of the author sees that
you reposted something, but not what it says. Only posts for all friends can be reposted or sent in
a chat, and the author can switch both off in their settings.

Imported by main.py at the very bottom, after everything it needs is defined.
"""

import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from . import media, moderation
from .main import POST_AUDIENCES, avatar_url, clean_text, current_user, friend_ids, get_conn, manager
from .postaccess import HIDE_AFTER_REPORTS, POST_SELECT, Viewer, blocked_with, is_admin

router = APIRouter()

POST_LIMIT = 500  # characters in a post
NOTE_LIMIT = 300  # characters in the note on a repost
FEED_PAGE = 20
POSTS_PER_WINDOW = 15  # how many posts and reposts one person can make ...
POST_WINDOW = 10 * 60  # ... in this many seconds
REPORT_REASONS = ("nudity", "violence", "harassment", "other")
LIKERS_SHOWN = 3  # names shown under a post, the rest are behind "liked by"
_recent: dict[int, deque] = defaultdict(deque)  # user id -> when they last posted (in memory)


class PostBody(BaseModel):
    body: str = ""
    audience: str | None = None
    media: list[int] = []


class EditBody(BaseModel):
    body: str | None = None
    audience: str | None = None
    media: list[int] | None = None


class RepostBody(BaseModel):
    body: str = ""
    audience: str | None = None


class ReportBody(BaseModel):
    reason: str = "other"


class CloseFriendsBody(BaseModel):
    usernames: list[str] = []


def check_rate(user_id: int):
    now = time.monotonic()
    seen = _recent[user_id]
    while seen and now - seen[0] > POST_WINDOW:
        seen.popleft()
    if len(seen) >= POSTS_PER_WINDOW:
        raise HTTPException(429, "slow down, you've posted a lot in the last few minutes")
    seen.append(now)


def pick_audience(conn, user, wanted: str | None) -> str:
    """The audience the person asked for, or the one from their settings."""
    if wanted is None:
        wanted = conn.execute("SELECT post_audience FROM users WHERE id = ?", (user["id"],)).fetchone()[0]
    if wanted not in POST_AUDIENCES:
        raise HTTPException(400, "pick friends, close friends or only me")
    return wanted


def clean_words(value: str, limit: int, field: str) -> str:
    text = clean_text(value, limit, field, multiline=True)
    reason = moderation.check_text(text)
    if reason:
        raise HTTPException(400, reason)
    return text


# ---------- turning rows into what the browser gets ----------


def person(row) -> dict:
    return {
        "username": row["username"],
        "display_name": row["display_name"],
        "avatar": avatar_url(row["avatar_id"]),
    }


def likers(viewer: Viewer, post_id: int, limit: int | None = None) -> list[dict]:
    """The people who liked a post, newest like first, without anybody the viewer has a block with."""
    rows = viewer.conn.execute(
        "SELECT u.id, u.username, u.display_name, u.avatar_id FROM post_likes l "
        "JOIN users u ON u.id = l.user_id WHERE l.post_id = ? ORDER BY l.created_at DESC, l.rowid DESC LIMIT 500",
        (post_id,),
    ).fetchall()
    out = [person(r) for r in rows if r["id"] not in viewer.blocked]
    return out[:limit] if limit else out


def engagement(viewer: Viewer, row) -> dict:
    """Likes as this viewer is allowed to see them, following the author's likes setting:
    everyone = count and names, count = the author sees the names and everybody else only the
    number, private = only the author sees anything."""
    mine = row["author_id"] == viewer.id
    setting = row["likes_visibility"]
    names = mine or setting == "everyone"
    count = mine or setting in ("everyone", "count")
    return {
        "liked": bool(row["liked"]),
        "likes": row["likes"] if count else None,
        "likes_hidden": not count,
        "likes_names": names,
        "likers": likers(viewer, row["id"], LIKERS_SHOWN) if names else [],
    }


