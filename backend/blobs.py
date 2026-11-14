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
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .main import current_user, get_conn

router = APIRouter()

MB = 1024 * 1024
CHUNK = 4 * MB  # plain bytes in one piece, the same number as FC_CHUNK in web/filecrypto.js
TAG = 16  # what AES-GCM adds to every piece
CHUNK_CT = CHUNK + TAG
MAX_FILE = int(os.environ.get("CIPHER_MAX_FILE_MB", "2048")) * MB  # like a WhatsApp document
QUOTA = int(os.environ.get("CIPHER_QUOTA_MB", "10240")) * MB  # per person, all their files together
KEEP_DAYS = int(os.environ.get("CIPHER_FILE_DAYS", "30"))
BLOB_DIR = Path(os.environ.get("CIPHER_BLOB_DIR", Path(__file__).parent / "blobs"))
ID_RE = re.compile(r"^[0-9a-f]{32}$")


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
