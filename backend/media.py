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

