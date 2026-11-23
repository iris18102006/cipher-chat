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
from .security import PersistentLimiter
from .postaccess import HIDE_AFTER_REPORTS, POST_SELECT, Viewer, blocked_with, comment_counts, is_admin

router = APIRouter()

POST_LIMIT = 500  # characters in a post
NOTE_LIMIT = 300  # characters in the note on a repost
FEED_PAGE = 20
POSTS_PER_WINDOW = 15  # how many posts and reposts one person can make ...
POST_WINDOW = 10 * 60  # ... in this many seconds
REPORT_REASONS = ("nudity", "violence", "harassment", "other")
LIKERS_SHOWN = 3  # names shown under a post, the rest are behind "liked by"
post_limiter = PersistentLimiter("feed-post", POSTS_PER_WINDOW, POST_WINDOW)


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
    if post_limiter.blocked(str(user_id)):
        raise HTTPException(429, "slow down, you've posted a lot in the last few minutes")
    post_limiter.hit(str(user_id))


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


def plain_post(viewer: Viewer, row, media_map: dict, counts: dict | None = None) -> dict:
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
        "comments": (counts or {}).get(row["id"], 0),
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
    counts = comment_counts(viewer, ids)
    out = []
    for r in rows:
        d = plain_post(viewer, r, media_map, counts)
        d["is_repost"] = bool(r["is_share"])
        if d["is_repost"]:
            if r["shared_id"] is None:
                d["original"] = {"gone": True}
            elif originals[r["shared_id"]] is None:
                # it was reposted to you, but it isn't yours to read: say nothing about it
                d["original"] = {"hidden": True}
            else:
                d["original"] = plain_post(viewer, originals[r["shared_id"]], media_map, counts)
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


@router.get("/api/feed/meta")
def feed_meta(user=Depends(current_user), conn=Depends(get_conn)):
    admin = is_admin(user)
    open_reports = 0
    if admin:
        open_reports = conn.execute(
            "SELECT COUNT(*) FROM posts p WHERE p.reviewed = 0 AND EXISTS "
            "(SELECT 1 FROM post_reports r WHERE r.post_id = p.id)"
        ).fetchone()[0]
    return {"admin": admin, "open_reports": open_reports}


@router.get("/api/posts/{post_id}")
def get_post(post_id: int, user=Depends(current_user), conn=Depends(get_conn)):
    viewer = Viewer(conn, user)
    return one_post(viewer, need_post(viewer, post_id))


# ---------- likes ----------


@router.post("/api/posts/{post_id}/like")
def like_post(post_id: int, user=Depends(current_user), conn=Depends(get_conn)):
    need_post(Viewer(conn, user), post_id)
    conn.execute("INSERT OR IGNORE INTO post_likes (post_id, user_id) VALUES (?, ?)", (post_id, user["id"]))
    conn.commit()
    return like_state(conn, post_id, user)


@router.delete("/api/posts/{post_id}/like")
def unlike_post(post_id: int, user=Depends(current_user), conn=Depends(get_conn)):
    need_post(Viewer(conn, user), post_id)
    conn.execute("DELETE FROM post_likes WHERE post_id = ? AND user_id = ?", (post_id, user["id"]))
    conn.commit()
    return like_state(conn, post_id, user)


def like_state(conn, post_id: int, user) -> dict:
    viewer = Viewer(conn, user)
    return engagement(viewer, need_post(viewer, post_id))


@router.get("/api/posts/{post_id}/likes")
def post_likes(post_id: int, user=Depends(current_user), conn=Depends(get_conn)):
    """Everybody who liked it, if the author lets this person see the names."""
    viewer = Viewer(conn, user)
    row = need_post(viewer, post_id)
    if row["author_id"] != viewer.id and row["likes_visibility"] != "everyone":
        raise HTTPException(403, "the author keeps the names of who liked this private")
    people = likers(viewer, post_id)
    return {"count": len(people), "likers": people}


# ---------- reposting ----------


@router.post("/api/posts/{post_id}/repost")
async def repost_post(post_id: int, body: RepostBody, user=Depends(current_user), conn=Depends(get_conn)):
    viewer = Viewer(conn, user)
    target = need_post(viewer, post_id)
    # reposting a repost reposts what it points at, so a chain of reposts is never longer than one
    if target["is_share"]:
        if target["shared_id"] is None:
            raise HTTPException(404, "that post is gone")
        target = need_post(viewer, target["shared_id"])
    if target["audience"] != "friends":
        raise HTTPException(403, "that post is only for a few people, so it can't be reposted")
    if not target["allow_reposts"]:
        raise HTTPException(403, "the author doesn't let people repost their posts")
    note = clean_words(body.body, NOTE_LIMIT, "note")
    audience = pick_audience(conn, user, body.audience)
    already = conn.execute(
        "SELECT 1 FROM posts WHERE author_id = ? AND shared_id = ?", (user["id"], target["id"])
    ).fetchone()
    if already:
        raise HTTPException(409, "you already reposted that")
    check_rate(user["id"])
    cur = conn.execute(
        "INSERT INTO posts (author_id, body, shared_id, is_share, audience) VALUES (?, ?, ?, 1, ?)",
        (user["id"], note, target["id"], audience),
    )
    conn.commit()
    await tell_friends(conn, user, cur.lastrowid, audience)
    viewer = Viewer(conn, user)
    return one_post(viewer, viewer.row(cur.lastrowid))


# ---------- reports and moderators ----------


@router.post("/api/posts/{post_id}/report")
def report_post(post_id: int, body: ReportBody, user=Depends(current_user), conn=Depends(get_conn)):
    viewer = Viewer(conn, user)
    row = need_post(viewer, post_id)
    if row["author_id"] == viewer.id:
        raise HTTPException(400, "that's your own post")
    if body.reason not in REPORT_REASONS:
        raise HTTPException(400, "pick nudity, violence, harassment or other")
    conn.execute(
        "INSERT OR REPLACE INTO post_reports (post_id, reporter_id, reason) VALUES (?, ?, ?)",
        (post_id, user["id"], body.reason),
    )
    count = conn.execute("SELECT COUNT(*) FROM post_reports WHERE post_id = ?", (post_id,)).fetchone()[0]
    if count >= HIDE_AFTER_REPORTS and not row["reviewed"]:
        conn.execute("UPDATE posts SET hidden = 1 WHERE id = ?", (post_id,))
    conn.commit()
    return {"reported": True}


def need_admin(user):
    # the same answer a page that doesn't exist would give
    if not is_admin(user):
        raise HTTPException(404, "not found")


@router.get("/api/admin/reports")
def admin_reports(user=Depends(current_user), conn=Depends(get_conn)):
    """Reported posts nobody has looked at yet, the most reported first."""
    need_admin(user)
    viewer = Viewer(conn, user)
    ids = conn.execute(
        "SELECT p.id FROM posts p WHERE p.reviewed = 0 AND EXISTS (SELECT 1 FROM post_reports r WHERE r.post_id = p.id) "
        "ORDER BY (SELECT COUNT(*) FROM post_reports r WHERE r.post_id = p.id) DESC, p.id DESC LIMIT 50"
    ).fetchall()
    out = []
    for (post_id,) in ids:
        row = viewer.raw_row(post_id)
        reasons = conn.execute(
            "SELECT reason, COUNT(*) AS n FROM post_reports WHERE post_id = ? GROUP BY reason", (post_id,)
        ).fetchall()
        post = plain_post(viewer, row, media.media_for(conn, [post_id]))
        post["is_repost"] = bool(row["is_share"])
        out.append(
            {
                "post": post,
                "hidden": bool(row["hidden"]),
                "reports": sum(r["n"] for r in reasons),
                "reasons": {r["reason"]: r["n"] for r in reasons},
            }
        )
    return {"reports": out}


@router.post("/api/admin/posts/{post_id}/keep")
def admin_keep(post_id: int, user=Depends(current_user), conn=Depends(get_conn)):
    """It's fine: show it again, and don't let more reports hide it."""
    need_admin(user)
    if not conn.execute("SELECT 1 FROM posts WHERE id = ?", (post_id,)).fetchone():
        raise HTTPException(404, "no such post")
    conn.execute("UPDATE posts SET hidden = 0, reviewed = 1 WHERE id = ?", (post_id,))
    conn.execute("DELETE FROM post_reports WHERE post_id = ?", (post_id,))
    conn.commit()
    return {"ok": True}


@router.delete("/api/admin/posts/{post_id}")
def admin_remove(post_id: int, user=Depends(current_user), conn=Depends(get_conn)):
    """It breaks the rules: delete it (reposts of it say the original was deleted)."""
    need_admin(user)
    cur = conn.execute("DELETE FROM posts WHERE id = ?", (post_id,))
    conn.commit()
    if not cur.rowcount:
        raise HTTPException(404, "no such post")
    return {"ok": True}


# ---------- close friends ----------


def close_friends_list(conn, user) -> dict:
    friends = friend_ids(conn, user["id"]) - blocked_with(conn, user["id"])
    if not friends:
        return {"friends": []}
    rows = conn.execute(
        "SELECT u.username, u.display_name, u.avatar_id, "
        "EXISTS (SELECT 1 FROM close_friends c WHERE c.owner_id = ? AND c.friend_id = u.id) AS close "
        f"FROM users u WHERE u.id IN ({','.join('?' * len(friends))}) ORDER BY LOWER(u.username)",
        [user["id"], *sorted(friends)],
    ).fetchall()
    return {"friends": [{**person(r), "close": bool(r["close"])} for r in rows]}


@router.get("/api/close-friends")
def get_close_friends(user=Depends(current_user), conn=Depends(get_conn)):
    return close_friends_list(conn, user)


@router.put("/api/close-friends")
def put_close_friends(body: CloseFriendsBody, user=Depends(current_user), conn=Depends(get_conn)):
    """Replaces the whole list. Everyone on it has to be a friend."""
    if len(body.usernames) > 500:
        raise HTTPException(400, "that's too many people")
    wanted = {n.strip().lower() for n in body.usernames if n.strip()}
    friends = friend_ids(conn, user["id"]) - blocked_with(conn, user["id"])
    chosen: set[int] = set()
    for name in wanted:
        row = conn.execute("SELECT id FROM users WHERE username = ?", (name,)).fetchone()
        if not row or row["id"] not in friends:
            raise HTTPException(400, "you can only add your friends")
        chosen.add(row["id"])
    conn.execute("DELETE FROM close_friends WHERE owner_id = ?", (user["id"],))
    conn.executemany(
        "INSERT INTO close_friends (owner_id, friend_id) VALUES (?, ?)", [(user["id"], fid) for fid in sorted(chosen)]
    )
    conn.commit()
    return close_friends_list(conn, user)
