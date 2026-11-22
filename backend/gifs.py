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
from pathlib import Path

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


def _media(url: str) -> tuple[bytes, str]:
    """One picture from GIPHY's picture hosts. Swapped out by the tests."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https" or not MEDIA_HOST.match(parts.hostname or ""):
        raise OSError("not a GIPHY picture address")
    return _get(url, MAX_MEDIA_BYTES)


def _remember(gid: str, preview: str, full: str):
    _seen[gid] = {"preview": preview, "full": full}
    _seen.move_to_end(gid)
    while len(_seen) > CACHE_SIZE:
        _seen.popitem(last=False)


def _url_of(images: dict, *names: str) -> str:
    for name in names:
        url = (images.get(name) or {}).get("url", "")
        parts = urllib.parse.urlsplit(url)
        if parts.scheme == "https" and MEDIA_HOST.match(parts.hostname or ""):
            return url
    return ""


def _results(payload: dict) -> list[dict]:
    out = []
    for item in payload.get("data", []):
        gid = str(item.get("id", ""))
        images = item.get("images") or {}
        preview = _url_of(images, "fixed_width_small", "fixed_width", "downsized")
        full = _url_of(images, "downsized_medium", "downsized", "fixed_width", "original")
        if not GIF_ID.match(gid) or not preview or not full:
            continue
        _remember(gid, preview, full)
        shape = images.get("fixed_width_small") or images.get("fixed_width") or {}
        out.append(
            {
                "id": gid,
                "title": clean_text(str(item.get("title", "")), 80, "title")[:80] if item.get("title") else "",
                "preview": f"/api/gifs/media/{gid}/preview",
                "width": int(shape.get("width") or 0) or 0,
                "height": int(shape.get("height") or 0) or 0,
            }
        )
    return out


def _need_search(user):
    if not api_key():
        raise HTTPException(404, "GIF search isn't switched on on this server")
    if search_limiter.blocked(str(user["id"])):
        raise HTTPException(429, "slow down, you've searched a lot just now")
    search_limiter.hit(str(user["id"]))


@router.get("/api/gifs/status")
def status(user=Depends(current_user)):
    return {"search": bool(api_key()), "max": MAX_GIFS, "page": PAGE}


@router.get("/api/gifs/search")
async def search(
    q: str = Query("", max_length=100),
    offset: int = Query(0, ge=0, le=500),
    user=Depends(current_user),
):
    """GIFs for some words, or what's popular right now when there are none."""
    _need_search(user)
    words = clean_text(q, 50, "search")
    path, params = ("search", {"q": words}) if words else ("trending", {})
    try:
        payload = await run_in_threadpool(_api, path, {**params, "limit": PAGE, "offset": offset})
    except (OSError, ValueError):
        raise HTTPException(502, "couldn't reach the GIF service, try again in a moment")
    found = _results(payload)
    return {"gifs": found, "next": offset + PAGE if len(found) >= PAGE - 4 else None}


@router.get("/api/gifs/media/{gid}/{size}")
async def search_media(gid: str, size: str, user=Depends(current_user)):
    """One picture from a search, passed on from GIPHY. size is preview or full."""
    if size not in ("preview", "full") or not GIF_ID.match(gid) or gid not in _seen:
        raise HTTPException(404, "no such GIF, search again")
    if media_limiter.blocked(str(user["id"])):
        raise HTTPException(429, "slow down")
    media_limiter.hit(str(user["id"]))
    try:
        body, kind = await run_in_threadpool(_media, _seen[gid][size])
    except OSError:
        raise HTTPException(502, "couldn't load that GIF")
    # only animated pictures go through, whatever the other end says it is
    if kind not in ("image/gif", "image/webp") or not (body[:4] == b"GIF8" or body[8:12] == b"WEBP"):
        raise HTTPException(502, "couldn't load that GIF")
    return Response(
        content=body,
        media_type=kind,
        headers={
            "Cache-Control": "private, max-age=86400",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
        },
    )


# ---------- your own GIFs ----------


def library(conn, user_id: int) -> dict:
    rows = conn.execute(
        "SELECT id, width, height, animated FROM images WHERE owner_id = ? AND kind = 'gif' ORDER BY id DESC",
        (user_id,),
    ).fetchall()
    return {
        "gifs": [
            {"id": r["id"], "url": f"/api/img/{r['id']}", "width": r["width"], "height": r["height"], "animated": bool(r["animated"])}
            for r in rows
        ],
        "max": MAX_GIFS,
    }


@router.get("/api/me/gifs")
def my_gifs(user=Depends(current_user), conn=Depends(get_conn)):
    return library(conn, user["id"])


@router.post("/api/me/gifs")
async def add_gif(request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    have = conn.execute("SELECT COUNT(*) FROM images WHERE owner_id = ? AND kind = 'gif'", (user["id"],)).fetchone()[0]
    if have >= MAX_GIFS:
        raise HTTPException(400, f"you can keep up to {MAX_GIFS} GIFs, remove one first")
    raw = await read_body(request, MAX_GIF_UPLOAD)
    img = await run_in_threadpool(process_image, raw, "gif")
    reason = await run_in_threadpool(moderation.check_image, img["data"])
    if reason:
        raise HTTPException(400, reason)
    conn.execute(
        "INSERT INTO images (owner_id, kind, mime, data, width, height, animated) VALUES (?, 'gif', ?, ?, ?, ?, ?)",
        (user["id"], img["mime"], img["data"], img["width"], img["height"], img["animated"]),
    )
    conn.commit()
    return library(conn, user["id"])


@router.delete("/api/me/gifs/{image_id}")
def remove_gif(image_id: int, user=Depends(current_user), conn=Depends(get_conn)):
    cur = conn.execute(
        "DELETE FROM images WHERE id = ? AND owner_id = ? AND kind = 'gif'", (image_id, user["id"])
    )
    conn.commit()
    if not cur.rowcount:
        raise HTTPException(404, "no such GIF")
    return library(conn, user["id"])
