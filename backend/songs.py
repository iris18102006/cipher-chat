"""A song on your profile that people can press play on.

You upload one audio file. The server checks that it really is audio (it looks at the first
bytes, not at the name or the type the browser claims) and keeps it in the database. Only
logged-in people can load it, and someone who blocked you doesn't let you hear theirs.

Imported by main.py at the very bottom, after everything it needs is defined.
"""

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from .main import MAX_SONG_UPLOAD, current_user, get_conn, i_blocked, read_body

router = APIRouter()

SONG_HEADERS = {
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Accept-Ranges": "bytes",
}


def sniff_audio(raw: bytes) -> str | None:
    """The audio type a file really is, or None. Only formats every browser can play."""
    head = raw[:16]
    if len(raw) < 64:
        return None
    if head[:3] == b"ID3":
        return "audio/mpeg"
    # an mp3 without a tag starts straight on a frame: eleven set bits, then a valid layer
    if head[0] == 0xFF and head[1] & 0xE0 == 0xE0 and head[1] & 0x06 != 0:
        return "audio/mpeg"
    if head[:4] == b"OggS":
        return "audio/ogg"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "audio/wav"
    if head[:4] == b"fLaC":
        return "audio/flac"
    if head[4:8] == b"ftyp":
        return "audio/mp4"
    return None


def song_url(song_id) -> str:
    return f"/api/song/{song_id}" if song_id else ""


@router.put("/api/me/song")
async def upload_song(request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    raw = await read_body(request, MAX_SONG_UPLOAD)
    mime = sniff_audio(raw)
    if not mime:
        raise HTTPException(400, "use an mp3, ogg, wav, flac or m4a file")
    # a new row every time (so a new url), because browsers keep the old song for an hour
    conn.execute("DELETE FROM songs WHERE owner_id = ?", (user["id"],))
    cur = conn.execute(
        "INSERT INTO songs (owner_id, mime, data) VALUES (?, ?, ?)", (user["id"], mime, raw)
    )
    conn.commit()
    return {"song_url": song_url(cur.lastrowid)}


@router.delete("/api/me/song")
def remove_song(user=Depends(current_user), conn=Depends(get_conn)):
    conn.execute("DELETE FROM songs WHERE owner_id = ?", (user["id"],))
    conn.commit()
    return {"song_url": ""}
