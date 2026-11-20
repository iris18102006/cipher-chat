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


