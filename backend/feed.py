"""The feed: short posts that you and your friends can see.

Posts are plain text (never rendered as html) and, like everything on a profile, they are
not encrypted: only messages are. You see your own posts and your friends' posts, nobody
else's, and nothing from someone you have a block with.

A post can be shared. A share is a post of its own (with an optional note) that points at the
original. Sharing never opens the original up to more people: a friend of yours who isn't a
friend of the author sees that you shared something, but not what it says.

Imported by main.py at the very bottom, after everything it needs is defined.
"""

import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from .main import avatar_url, clean_text, current_user, friend_ids, get_conn, manager

router = APIRouter()

POST_LIMIT = 500  # characters in a post
NOTE_LIMIT = 300  # characters in the note on a share
FEED_PAGE = 20
POSTS_PER_WINDOW = 15  # how many posts and shares one person can make ...
POST_WINDOW = 10 * 60  # ... in this many seconds
_recent: dict[int, deque] = defaultdict(deque)  # user id -> when they last posted (in memory)


class PostBody(BaseModel):
    body: str


class ShareBody(BaseModel):
    body: str = ""


# ---------- who can see what ----------


def blocked_with(conn, user_id: int) -> set[int]:
    """Everyone I blocked or who blocked me."""
    rows = conn.execute(
        "SELECT blocked_id FROM blocks WHERE blocker_id = :me "
        "UNION SELECT blocker_id FROM blocks WHERE blocked_id = :me",
        {"me": user_id},
    ).fetchall()
    return {r[0] for r in rows}


def visible_authors(conn, user_id: int) -> set[int]:
    """Whose posts I can see: mine and my friends', minus anybody I have a block with."""
    return ({user_id} | friend_ids(conn, user_id)) - blocked_with(conn, user_id)


def check_rate(user_id: int):
    now = time.monotonic()
    seen = _recent[user_id]
    while seen and now - seen[0] > POST_WINDOW:
        seen.popleft()
    if len(seen) >= POSTS_PER_WINDOW:
        raise HTTPException(429, "slow down, you've posted a lot in the last few minutes")
    seen.append(now)


# ---------- turning rows into what the browser gets ----------

POST_SELECT = """
    SELECT p.id, p.author_id, p.body, p.shared_id, p.is_share, p.created_at,
           u.username, u.display_name, u.avatar_id,
           (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id) AS likes,
           EXISTS (SELECT 1 FROM post_likes l WHERE l.post_id = p.id AND l.user_id = :me) AS liked,
           (SELECT COUNT(*) FROM posts s WHERE s.shared_id = p.id) AS shares
    FROM posts p JOIN users u ON u.id = p.author_id
"""


def post_row(conn, post_id: int, me_id: int):
    return conn.execute(POST_SELECT + " WHERE p.id = :id", {"id": post_id, "me": me_id}).fetchone()


def plain_post(row, me_id: int) -> dict:
    return {
        "id": row["id"],
        "author": {
            "username": row["username"],
            "display_name": row["display_name"],
            "avatar": avatar_url(row["avatar_id"]),
        },
        "body": row["body"],
        "created_at": row["created_at"],
        "mine": row["author_id"] == me_id,
        "likes": row["likes"],
        "liked": bool(row["liked"]),
        "shares": row["shares"],
    }


def post_dict(conn, row, me_id: int, can_see: set[int]) -> dict:
    """One post. For a share, `original` is the post it points at, or says why it can't be shown."""
    out = plain_post(row, me_id)
    out["is_share"] = bool(row["is_share"])
    if not out["is_share"]:
        return out
    orig = post_row(conn, row["shared_id"], me_id) if row["shared_id"] is not None else None
    if not orig:
        out["original"] = {"gone": True}
    elif orig["author_id"] not in can_see:
        # it was shared with you, but it isn't yours to read: say nothing about it
        out["original"] = {"hidden": True}
    else:
        out["original"] = plain_post(orig, me_id)
    return out
