"""GIFs for chats.

There are two places a GIF can come from:

1. Your own GIF library: GIFs and pictures you uploaded to keep (up to MAX_GIFS). This always works.
2. GIPHY search, only if the person running the server set CIPHER_GIPHY_KEY (a free key from
   developers.giphy.com). The browser never talks to GIPHY: it asks this server, the server asks
   GIPHY and passes the pictures on. That keeps the page's strict content policy (no other
   sites), and keeps people's addresses away from GIPHY. The server only ever fetches from
   GIPHY's own picture hosts, over https, and doesn't follow redirects.

Sending a GIF in a chat is the same as sending any picture: the browser downloads it, locks it and
sends it like a file, so the chat itself stays end-to-end encrypted. Only the search words go
through the server (and GIPHY), never what is said in the chat.

Imported by main.py at the very bottom, after everything it needs is defined.
"""

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool

from . import moderation
from .main import MAX_GIF_UPLOAD, MAX_GIFS, clean_text, current_user, get_conn, process_image, read_body
from .security import SlidingLimiter

router = APIRouter()

API = "https://api.giphy.com/v1/gifs/"
MEDIA_HOST = re.compile(r"^(?:media\d*|i)\.giphy\.com$")
GIF_ID = re.compile(r"^[A-Za-z0-9]{3,40}$")
PAGE = 24
MAX_MEDIA_BYTES = 8 * 1024 * 1024
TIMEOUT = 8
CACHE_SIZE = 1500

search_limiter = SlidingLimiter(60, 60)  # searches per person per minute
media_limiter = SlidingLimiter(400, 60)  # pictures per person per minute

# what GIPHY told us about each result, so the picture can be fetched by id. Never from the browser.
_seen: "OrderedDict[str, dict]" = OrderedDict()


def api_key() -> str:
    return os.environ.get("CIPHER_GIPHY_KEY", "").strip()


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # a redirect is an error, so we can't be led elsewhere
        return None


_opener = urllib.request.build_opener(_NoRedirects)


def _get(url: str, limit: int) -> tuple[bytes, str]:
    """(body, content type) of one https address. Raises OSError for anything that goes wrong."""
    req = urllib.request.Request(url, headers={"User-Agent": "cipher-chat", "Accept": "*/*"})
    with _opener.open(req, timeout=TIMEOUT) as res:
        body = res.read(limit + 1)
        if len(body) > limit:
            raise OSError("too big")
        return body, res.headers.get_content_type()


def _api(path: str, params: dict) -> dict:
    """One call to the GIPHY api. Swapped out by the tests."""
    query = urllib.parse.urlencode({"api_key": api_key(), "rating": "pg", "lang": "en", **params})
    body, _ = _get(API + path + "?" + query, 1024 * 1024)
    return json.loads(body)


