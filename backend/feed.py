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


def plain_post(viewer: Viewer, row, media_map: dict) -> dict:
    mine = row["author_id"] == viewer.id
    open_post = row["audience"] == "friends" and not row["hidden"]
    return {
        "id": row["id"],
        "author": person(row),
        "body": row["body"],
        "created_at": row["created_at"],
        "edited": row["edited_at"] is not None,
        "audience": row["audience"],
        "mine": mine,
        "hidden": bool(row["hidden"]) and mine,  # only the author is told it is hidden
        "reported": bool(row["reported"]),
        "reposts": row["reposts"],
        "media": media_map.get(row["id"], []),
        # only posts for all friends can leave the circle they were made for, and only if the author allows it
        "can_repost": open_post and bool(row["allow_reposts"]),
        "can_send": open_post and bool(row["allow_chat_shares"]),
        **engagement(viewer, row),
    }


def post_dicts(viewer: Viewer, rows) -> list[dict]:
    """Posts for the browser. For a repost, `original` is the post it points at, or says why it can't be shown."""
    originals: dict = {}
    for r in rows:
        if r["is_share"] and r["shared_id"] is not None and r["shared_id"] not in originals:
            originals[r["shared_id"]] = viewer.row(r["shared_id"])
    ids = [r["id"] for r in rows] + [o["id"] for o in originals.values() if o]
    media_map = media.media_for(viewer.conn, ids)
    out = []
    for r in rows:
        d = plain_post(viewer, r, media_map)
        d["is_repost"] = bool(r["is_share"])
        if d["is_repost"]:
            if r["shared_id"] is None:
                d["original"] = {"gone": True}
            elif originals[r["shared_id"]] is None:
                # it was reposted to you, but it isn't yours to read: say nothing about it
                d["original"] = {"hidden": True}
            else:
                d["original"] = plain_post(viewer, originals[r["shared_id"]], media_map)
        out.append(d)
    return out


def one_post(viewer: Viewer, row) -> dict:
    return post_dicts(viewer, [row])[0]


def need_post(viewer: Viewer, post_id: int):
    """A post the person is allowed to see, or the same 404 whether it's missing or private."""
    row = viewer.row(post_id)
    if not row:
        raise HTTPException(404, "no such post")
    return row


async def tell_friends(conn, user, post_id: int, audience: str):
    """A little nudge to everybody who can see it and is online, so their feed can say 'new posts'."""
    if audience == "me":
        return
    ids = friend_ids(conn, user["id"]) - blocked_with(conn, user["id"])
    if audience == "close":
        close = conn.execute("SELECT friend_id FROM close_friends WHERE owner_id = ?", (user["id"],)).fetchall()
        ids &= {r[0] for r in close}
    if not ids:
        return
    names = conn.execute(
        f"SELECT username FROM users WHERE notify_posts = 1 AND id IN ({','.join('?' * len(ids))})", list(ids)
    ).fetchall()
    for r in names:
        await manager.send_user(r["username"], {"type": "feed", "event": "new", "id": post_id, "from": user["username"]})


# ---------- writing, editing, deleting ----------


@router.post("/api/posts")
async def create_post(body: PostBody, user=Depends(current_user), conn=Depends(get_conn)):
    text = clean_words(body.body, POST_LIMIT, "post")
    ids = media.plan(conn, user["id"], body.media)
    if not text and not ids:
        raise HTTPException(400, "write something first")
    audience = pick_audience(conn, user, body.audience)
    check_rate(user["id"])
    cur = conn.execute("INSERT INTO posts (author_id, body, audience) VALUES (?, ?, ?)", (user["id"], text, audience))
    media.attach(conn, cur.lastrowid, ids)
    conn.commit()
    await tell_friends(conn, user, cur.lastrowid, audience)
    viewer = Viewer(conn, user)
    return one_post(viewer, viewer.row(cur.lastrowid))


@router.patch("/api/posts/{post_id}")
def edit_post(post_id: int, body: EditBody, user=Depends(current_user), conn=Depends(get_conn)):
    # somebody else's post is "not found", the same answer as one that doesn't exist
    row = conn.execute(
        "SELECT author_id, body, is_share, audience FROM posts WHERE id = ?", (post_id,)
    ).fetchone()
    if not row or row["author_id"] != user["id"]:
        raise HTTPException(404, "no such post")
    is_repost = bool(row["is_share"])
    old_ids = media.current_ids(conn, post_id)
    text = row["body"] if body.body is None else clean_words(body.body, NOTE_LIMIT if is_repost else POST_LIMIT, "post")
    if body.media is not None and is_repost and body.media:
        raise HTTPException(400, "a repost can't have its own files")
    ids = old_ids if body.media is None else media.plan(conn, user["id"], body.media, post_id)
    if not is_repost and not text and not ids:
        raise HTTPException(400, "a post needs some words or a file")
    audience = row["audience"] if body.audience is None else pick_audience(conn, user, body.audience)
    changed = text != row["body"] or ids != old_ids
    conn.execute(
        "UPDATE posts SET body = ?, audience = ?, edited_at = CASE WHEN ? THEN datetime('now') ELSE edited_at END "
        "WHERE id = ?",
        (text, audience, int(changed), post_id),
    )
    if body.media is not None:
        media.attach(conn, post_id, ids)
    conn.commit()
    viewer = Viewer(conn, user)
    return one_post(viewer, viewer.row(post_id))


@router.delete("/api/posts/{post_id}")
def delete_post(post_id: int, user=Depends(current_user), conn=Depends(get_conn)):
    row = conn.execute("SELECT author_id FROM posts WHERE id = ?", (post_id,)).fetchone()
    if not row or row["author_id"] != user["id"]:
        raise HTTPException(404, "no such post")
    conn.execute("DELETE FROM posts WHERE id = ?", (post_id,))
    conn.commit()
    return {"ok": True}


# ---------- reading ----------


@router.get("/api/feed")
def get_feed(
    before: int | None = None,
    limit: int = Query(FEED_PAGE, ge=1, le=50),
    tab: str = Query("all", pattern="^(all|close|mine)$"),
    user=Depends(current_user),
    conn=Depends(get_conn),
):
    """Newest first. `before` is the id of the oldest post you already have.
    tab: all = everything you can see, close = posts for close friends, mine = your own."""
    viewer = Viewer(conn, user)
    extra = ""
    if tab == "close":
        extra = " AND p.audience = 'close'"
    elif tab == "mine":
        extra = " AND p.author_id = :me"
    rows = conn.execute(
        POST_SELECT + f" WHERE {viewer.clause}{extra} AND (:before IS NULL OR p.id < :before) "
        "ORDER BY p.id DESC LIMIT :limit",
        viewer.args(before=before, limit=limit + 1),
    ).fetchall()
    return {"posts": post_dicts(viewer, rows[:limit]), "more": len(rows) > limit}


