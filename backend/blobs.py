"""Files people send in chats, kept encrypted.

The browser locks a file in pieces (web/filecrypto.js) and uploads the pieces one by one. All this
server ever holds is scrambled bytes under a random id: the file's name, its type and its key
travel inside the end-to-end encrypted chat message, so the server doesn't know what a file is
or which chat it belongs to. Anyone logged in who knows an id can fetch the pieces, which is
useless without the key.

The pieces live on disk, not in the database, and files are removed after a while.

Imported by main.py at the very bottom, after everything it needs is defined.
"""

import os
import re
import secrets
import shutil
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from .main import current_user, get_conn, read_body

router = APIRouter()

MB = 1024 * 1024
CHUNK = 4 * MB  # plain bytes in one piece, the same number as FC_CHUNK in web/filecrypto.js
TAG = 16  # what AES-GCM adds to every piece
CHUNK_CT = CHUNK + TAG
MAX_FILE = int(os.environ.get("CIPHER_MAX_FILE_MB", "2048")) * MB  # like a WhatsApp document
QUOTA = int(os.environ.get("CIPHER_QUOTA_MB", "10240")) * MB  # per person, all their files together
KEEP_DAYS = int(os.environ.get("CIPHER_FILE_DAYS", "30"))
UNFINISHED_HOURS = int(os.environ.get("CIPHER_UNFINISHED_HOURS", "6"))  # an upload that never finished is dropped after this
BLOB_DIR = Path(os.environ.get("CIPHER_BLOB_DIR", Path(__file__).parent / "blobs"))
ID_RE = re.compile(r"^[0-9a-f]{32}$")

# what comes back is scrambled bytes, never to be treated as a page or a picture
PIECE_HEADERS = {
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
}


class NewBlob(BaseModel):
    pieces: int = Field(ge=1, le=100_000)
    size: int = Field(ge=TAG)  # the locked size, all the pieces together


def last_piece_size(pieces: int, size: int) -> int:
    return size - (pieces - 1) * CHUNK_CT


def check_shape(pieces: int, size: int) -> None:
    """A file has to be cut the way the browser cuts it: full pieces, then a last one."""
    most = max(1, -(-MAX_FILE // CHUNK))
    if pieces > most or size - pieces * TAG > MAX_FILE:
        raise HTTPException(413, f"that file is too big (max {MAX_FILE // MB} MB)")
    if not TAG <= last_piece_size(pieces, size) <= CHUNK_CT:
        raise HTTPException(400, "that file isn't cut the right way")


def used_bytes(conn, owner_id: int) -> int:
    row = conn.execute("SELECT COALESCE(SUM(size), 0) FROM blobs WHERE owner_id = ?", (owner_id,)).fetchone()
    return row[0]


@router.post("/api/blobs")
def new_blob(body: NewBlob, user=Depends(current_user), conn=Depends(get_conn)):
    check_shape(body.pieces, body.size)
    housekeeping(conn)
    if used_bytes(conn, user["id"]) + body.size > QUOTA:
        raise HTTPException(413, f"you've used up your file space ({QUOTA // MB} MB), files are removed after {KEEP_DAYS} days")
    blob_id = secrets.token_hex(16)
    conn.execute(
        "INSERT INTO blobs (id, owner_id, pieces, size) VALUES (?, ?, ?, ?)",
        (blob_id, user["id"], body.pieces, body.size),
    )
    conn.commit()
    (BLOB_DIR / blob_id).mkdir(parents=True, exist_ok=True)
    return {"id": blob_id}


def my_blob(conn, blob_id: str, user):
    row = None
    if ID_RE.fullmatch(blob_id):
        row = conn.execute("SELECT * FROM blobs WHERE id = ? AND owner_id = ?", (blob_id, user["id"])).fetchone()
    if not row:
        raise HTTPException(404, "no such file")
    return row


def piece_path(blob_id: str, index: int) -> Path:
    return BLOB_DIR / blob_id / str(index)


def write_piece(path: Path, raw: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".part")
    tmp.write_bytes(raw)
    tmp.replace(path)  # a piece is either all there or not there at all


@router.put("/api/blobs/{blob_id}/pieces/{index}")
async def put_piece(blob_id: str, index: int, request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    row = my_blob(conn, blob_id, user)
    if row["complete"]:
        raise HTTPException(409, "this file is already sent")
    if not 0 <= index < row["pieces"]:
        raise HTTPException(404, "no such piece")
    raw = await read_body(request, CHUNK_CT)
    last = index == row["pieces"] - 1
    want = last_piece_size(row["pieces"], row["size"]) if last else CHUNK_CT
    if len(raw) != want:
        raise HTTPException(400, "that piece is the wrong size")
    await run_in_threadpool(write_piece, piece_path(blob_id, index), raw)
    return {"ok": True}


@router.post("/api/blobs/{blob_id}/complete")
def finish_blob(blob_id: str, user=Depends(current_user), conn=Depends(get_conn)):
    row = my_blob(conn, blob_id, user)
    if row["complete"]:
        return {"ok": True}
    total = 0
    for index in range(row["pieces"]):
        path = piece_path(blob_id, index)
        if not path.is_file():
            raise HTTPException(400, f"piece {index} never arrived")
        total += path.stat().st_size
    if total != row["size"]:
        raise HTTPException(400, "the pieces don't add up to the size you said")
    conn.execute("UPDATE blobs SET complete = 1 WHERE id = ?", (blob_id,))
    conn.commit()
    return {"ok": True}


@router.get("/api/blobs/{blob_id}/pieces/{index}")
def get_piece(blob_id: str, index: int, user=Depends(current_user), conn=Depends(get_conn)):
    housekeeping(conn)
    row = None
    if ID_RE.fullmatch(blob_id):
        row = conn.execute(
            "SELECT pieces FROM blobs WHERE id = ? AND complete = 1 AND created_at > datetime('now', ?)",
            (blob_id, f"-{KEEP_DAYS} days"),
        ).fetchone()
    if not row or not 0 <= index < row["pieces"]:
        raise HTTPException(404, "no such file")
    try:
        data = piece_path(blob_id, index).read_bytes()
    except FileNotFoundError:
        raise HTTPException(404, "no such file")
    return Response(content=data, media_type="application/octet-stream", headers=PIECE_HEADERS)


def remove_files(blob_id: str) -> None:
    if ID_RE.fullmatch(blob_id):
        shutil.rmtree(BLOB_DIR / blob_id, ignore_errors=True)


@router.delete("/api/blobs/{blob_id}")
def delete_blob(blob_id: str, user=Depends(current_user), conn=Depends(get_conn)):
    my_blob(conn, blob_id, user)
    conn.execute("DELETE FROM blobs WHERE id = ?", (blob_id,))
    conn.commit()
    remove_files(blob_id)
    return {"ok": True}


def purge(conn) -> int:
    """Forget files that are too old, and uploads that were never finished."""
    old = conn.execute(
        "SELECT id FROM blobs WHERE created_at <= datetime('now', ?) "
        "OR (complete = 0 AND created_at <= datetime('now', ?))",
        (f"-{KEEP_DAYS} days", f"-{UNFINISHED_HOURS} hours"),
    ).fetchall()
    for row in old:
        remove_files(row["id"])
    conn.executemany("DELETE FROM blobs WHERE id = ?", [(row["id"],) for row in old])
    conn.commit()
    return len(old)


_last_purge = 0.0


def housekeeping(conn) -> None:
    """Clean up at most once an hour, whenever somebody uses files."""
    global _last_purge
    if time.monotonic() - _last_purge > 3600:
        _last_purge = time.monotonic()
        purge(conn)
