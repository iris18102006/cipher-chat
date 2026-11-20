"""Photos, videos and music on feed posts.

You upload a file first (it waits as a draft) and then attach it to a post when you post or edit.
The server looks at the first bytes to find out what a file really is, never at the name or the
type the browser says. Pictures are decoded and saved again (a picture that isn't one is refused,
and hidden data like GPS is thrown away), and go through the picture check in moderation.py.
Videos and songs are only checked for what they are and how big they are.

Who can load a file follows who can see the post it is on (postaccess.py). A draft is only for
the person who uploaded it.

Imported by main.py at the very bottom, after everything it needs is defined.
"""

from collections import Counter

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool

from . import moderation
from .main import MAX_PHOTO_UPLOAD, MAX_SONG_UPLOAD, current_user, get_conn, process_image, read_body
from .postaccess import Viewer
from .songs import byte_range, sniff_audio
from .security import SlidingLimiter

router = APIRouter()

MAX_VIDEO_UPLOAD = 25 * 1024 * 1024
MAX_IMAGES = 4  # pictures on one post
MAX_PER_POST = 5  # 4 pictures and a song, or a video and a song
DRAFT_LIMIT = 12  # files that are uploaded but not on a post yet
DRAFT_HOURS = 24  # ... and they are thrown away after this long
UPLOADS_PER_WINDOW = 30
upload_limiter = SlidingLimiter(UPLOADS_PER_WINDOW, 10 * 60)

TYPES_TEXT = "use a png, jpg, gif or webp picture, an mp4 or webm video, or an mp3, ogg, wav, flac or m4a song"

MEDIA_HEADERS = {
    "Cache-Control": "private, max-age=300",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Accept-Ranges": "bytes",
}

# the "brand" an mp4 file says it is. Music files say M4A, videos say one of these
VIDEO_BRANDS = {b"isom", b"iso2", b"mp41", b"mp42", b"avc1", b"M4V ", b"msnv", b"dash"}


# ---------- what is this file? ----------


def sniff_image(raw: bytes) -> bool:
    head = raw[:16]
    return (
        head[:8] == b"\x89PNG\r\n\x1a\n"
        or head[:3] == b"\xff\xd8\xff"
        or head[:4] == b"GIF8"
        or (head[:4] == b"RIFF" and head[8:12] == b"WEBP")
    )


def sniff_video(raw: bytes) -> str | None:
    """video/mp4 or video/webm, or None. Only what every browser can play."""
    if len(raw) < 1024:
        return None
    if raw[4:8] == b"ftyp" and raw[8:12] in VIDEO_BRANDS:
        return "video/mp4"
    if raw[:4] == b"\x1aE\xdf\xa3" and b"webm" in raw[:64]:
        return "video/webm"
    return None


def classify(raw: bytes) -> tuple[str, str] | None:
    """('image' | 'video' | 'audio', mime) for what the bytes really are, or None."""
    if sniff_image(raw):
        return "image", ""
    video = sniff_video(raw)
    if video:
        return "video", video
    audio = sniff_audio(raw)
    if audio:
        return "audio", audio
    return None


def media_json(row) -> dict:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "url": f"/api/post-media/{row['id']}",
        "mime": row["mime"],
        "width": row["width"],
        "height": row["height"],
        "animated": bool(row["animated"]),
    }


# ---------- used by feed.py ----------


def media_for(conn, post_ids: list[int]) -> dict[int, list[dict]]:
    """post id -> the files on it, in order."""
    if not post_ids:
        return {}
    marks = ",".join("?" * len(post_ids))
    rows = conn.execute(
        f"SELECT id, post_id, kind, mime, width, height, animated FROM post_media "
        f"WHERE post_id IN ({marks}) ORDER BY post_id, position, id",
        post_ids,
    ).fetchall()
    out: dict[int, list[dict]] = {}
    for r in rows:
        out.setdefault(r["post_id"], []).append(media_json(r))
    return out


def plan(conn, user_id: int, ids: list[int], post_id: int | None = None) -> list[int]:
    """Checks that these files can go on a post (yours, not used by another post, a sensible mix)
    and gives them back in order. Raises a 400 with the reason otherwise."""
    if len(ids) != len(set(ids)):
        raise HTTPException(400, "the same file is on this post twice")
    if len(ids) > MAX_PER_POST:
        raise HTTPException(400, "that's too many files for one post")
    kinds: Counter = Counter()
    for media_id in ids:
        row = conn.execute(
            "SELECT kind, post_id FROM post_media WHERE id = ? AND owner_id = ?", (media_id, user_id)
        ).fetchone()
        if not row or (row["post_id"] is not None and row["post_id"] != post_id):
            raise HTTPException(400, "one of those files isn't yours or is already on another post")
        kinds[row["kind"]] += 1
    if kinds["image"] > MAX_IMAGES:
        raise HTTPException(400, f"a post can have up to {MAX_IMAGES} pictures")
    if kinds["video"] > 1:
        raise HTTPException(400, "a post can have one video")
    if kinds["audio"] > 1:
        raise HTTPException(400, "a post can have one song")
    if kinds["video"] and kinds["image"]:
        raise HTTPException(400, "a post can have pictures or a video, not both")
    return ids


def attach(conn, post_id: int, ids: list[int]):
    """Puts the files on the post in this order, and removes any other file it had."""
    marks = ",".join("?" * len(ids)) or "NULL"
    conn.execute(f"DELETE FROM post_media WHERE post_id = ? AND id NOT IN ({marks})", (post_id, *ids))
    for position, media_id in enumerate(ids):
        conn.execute(
            "UPDATE post_media SET post_id = ?, position = ? WHERE id = ?", (post_id, position, media_id)
        )


def current_ids(conn, post_id: int) -> list[int]:
    rows = conn.execute("SELECT id FROM post_media WHERE post_id = ? ORDER BY position, id", (post_id,)).fetchall()
    return [r["id"] for r in rows]


# ---------- routes ----------


def clear_old_drafts(conn, user_id: int):
    conn.execute(
        "DELETE FROM post_media WHERE owner_id = ? AND post_id IS NULL AND created_at < datetime('now', ?)",
        (user_id, f"-{DRAFT_HOURS} hours"),
    )


@router.post("/api/post-media")
async def upload_post_media(request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    key = str(user["id"])
    if upload_limiter.blocked(key):
        raise HTTPException(429, "slow down, you've uploaded a lot in the last few minutes")
    clear_old_drafts(conn, user["id"])
    drafts = conn.execute(
        "SELECT COUNT(*) FROM post_media WHERE owner_id = ? AND post_id IS NULL", (user["id"],)
    ).fetchone()[0]
    if drafts >= DRAFT_LIMIT:
        raise HTTPException(400, "post what you have first, or remove some of those files")
    raw = await read_body(request, MAX_VIDEO_UPLOAD)
    found = classify(raw)
    if not found:
        raise HTTPException(400, TYPES_TEXT)
    kind, mime = found
    if kind == "image" and len(raw) > MAX_PHOTO_UPLOAD:
        raise HTTPException(413, f"that picture is too big (max {MAX_PHOTO_UPLOAD // (1024 * 1024)} MB)")
    if kind == "audio" and len(raw) > MAX_SONG_UPLOAD:
        raise HTTPException(413, f"that song is too big (max {MAX_SONG_UPLOAD // (1024 * 1024)} MB)")
    width = height = animated = 0
    data = raw
    if kind == "image":
        img = await run_in_threadpool(process_image, raw, "post")
        reason = await run_in_threadpool(moderation.check_image, img["data"])
        if reason:
            raise HTTPException(400, reason)
        mime, data = img["mime"], img["data"]
        width, height, animated = img["width"], img["height"], img["animated"]
    upload_limiter.hit(key)
    cur = conn.execute(
        "INSERT INTO post_media (owner_id, kind, mime, data, width, height, animated) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (user["id"], kind, mime, data, width, height, animated),
    )
    conn.commit()
    row = conn.execute(
        "SELECT id, kind, mime, width, height, animated FROM post_media WHERE id = ?", (cur.lastrowid,)
    ).fetchone()
    return media_json(row)


@router.delete("/api/post-media/{media_id}")
def delete_draft(media_id: int, user=Depends(current_user), conn=Depends(get_conn)):
    """Throw away a file that isn't on a post yet. (A file on a post goes when the post is edited.)"""
    cur = conn.execute(
        "DELETE FROM post_media WHERE id = ? AND owner_id = ? AND post_id IS NULL", (media_id, user["id"])
    )
    conn.commit()
    if not cur.rowcount:
        raise HTTPException(404, "no such file")
    return {"ok": True}


@router.get("/api/post-media/{media_id}")
def get_post_media(media_id: int, request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    row = conn.execute(
        "SELECT owner_id, post_id, kind, mime, LENGTH(data) AS size FROM post_media WHERE id = ?", (media_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "no such file")
    if row["owner_id"] != user["id"]:
        # somebody else's file: only through a post they can see (or a reported one, for a moderator).
        # The answer is the same "no such file" whichever way it fails
        if row["post_id"] is None:
            raise HTTPException(404, "no such file")
        viewer = Viewer(conn, user)
        if not viewer.row(row["post_id"]) and not (viewer.admin and viewer.has_reports(row["post_id"])):
            raise HTTPException(404, "no such file")
    size = row["size"]
    piece = byte_range(request.headers.get("range", ""), size)
    if piece is None:
        data = conn.execute("SELECT data FROM post_media WHERE id = ?", (media_id,)).fetchone()["data"]
        return Response(content=bytes(data), media_type=row["mime"], headers=MEDIA_HEADERS)
    start, end = piece
    # substr on a blob counts bytes and starts at 1, so only the asked-for piece is read
    data = conn.execute(
        "SELECT SUBSTR(data, ?, ?) AS part FROM post_media WHERE id = ?", (start + 1, end - start + 1, media_id)
    ).fetchone()["part"]
    return Response(
        content=bytes(data),
        status_code=206,
        media_type=row["mime"],
        headers={**MEDIA_HEADERS, "Content-Range": f"bytes {start}-{end}/{size}"},
    )
