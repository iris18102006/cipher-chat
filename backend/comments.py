"""Comments under posts.

Anybody who can see a post can comment on it, and what they write is plain text (never rendered as
html) that the server checks like a post (moderation.py). You can edit and delete your own comments,
and the person whose post it is can delete any comment under it, so nobody has to leave somebody
else's words on their own post. Comments from somebody you have a block with are left out for you.

Comments go with their post: when a post is deleted, so are its comments.

Imported by main.py at the very bottom, after feed.py.
"""

import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from .feed import clean_words, need_post, person
from .main import current_user, get_conn, manager
from .postaccess import Viewer

router = APIRouter()

COMMENT_LIMIT = 300  # characters in a comment
COMMENTS_PAGE = 20
COMMENTS_PER_WINDOW = 20  # how many comments one person can make ...
COMMENT_WINDOW = 5 * 60  # ... in this many seconds
_recent: dict[int, deque] = defaultdict(deque)  # user id -> when they last commented (in memory)

COMMENT_SELECT = """
    SELECT c.id, c.post_id, c.author_id, c.body, c.created_at, c.edited_at,
           u.username, u.display_name, u.avatar_id
    FROM post_comments c JOIN users u ON u.id = c.author_id
"""


class CommentBody(BaseModel):
    body: str = ""


def check_rate(user_id: int):
    now = time.monotonic()
    seen = _recent[user_id]
    while seen and now - seen[0] > COMMENT_WINDOW:
        seen.popleft()
    if len(seen) >= COMMENTS_PER_WINDOW:
        raise HTTPException(429, "slow down, you've commented a lot in the last few minutes")
    seen.append(now)


def comment_dict(viewer: Viewer, row, post_author_id: int) -> dict:
    mine = row["author_id"] == viewer.id
    return {
        "id": row["id"],
        "post_id": row["post_id"],
        "author": person(row),
        "body": row["body"],
        "created_at": row["created_at"],
        "edited": row["edited_at"] is not None,
        "mine": mine,
        # you can delete your own, and anything under your own post
        "can_delete": mine or post_author_id == viewer.id,
    }


def need_comment(conn, user, comment_id: int):
    """(viewer, comment row, post row) for a comment under a post the person may see. The same
    404 whether the comment is missing or the post is private."""
    row = conn.execute(COMMENT_SELECT + " WHERE c.id = ?", (comment_id,)).fetchone()
    if not row:
        raise HTTPException(404, "no such comment")
    viewer = Viewer(conn, user)
    post = viewer.row(row["post_id"])
    if not post or row["author_id"] in viewer.blocked:
        raise HTTPException(404, "no such comment")
    return viewer, row, post


@router.get("/api/posts/{post_id}/comments")
def list_comments(
    post_id: int,
    before: int | None = None,
    limit: int = Query(COMMENTS_PAGE, ge=1, le=50),
    user=Depends(current_user),
    conn=Depends(get_conn),
):
    """Oldest first, like a chat. `before` is the id of the oldest comment you already have, to get
    the ones above it. The newest `limit` come first, and `more` says there are older ones."""
    viewer = Viewer(conn, user)
    post = need_post(viewer, post_id)
    rows = conn.execute(
        COMMENT_SELECT + " WHERE c.post_id = :post AND (:before IS NULL OR c.id < :before) ORDER BY c.id DESC",
        {"post": post_id, "before": before},
    ).fetchall()
    rows = [r for r in rows if r["author_id"] not in viewer.blocked]
    page = rows[:limit]
    return {
        "comments": [comment_dict(viewer, r, post["author_id"]) for r in reversed(page)],
        "more": len(rows) > limit,
    }
