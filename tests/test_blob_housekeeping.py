import logging

import pytest

from backend import db, main
from tests.test_backend import signup
from tests.test_blobs import age, piece, start, upload

blobs = main.blobs


@pytest.fixture(autouse=True)
def blob_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(blobs, "BLOB_DIR", tmp_path / "blobs")
    monkeypatch.setattr(blobs, "UNFINISHED_HOURS", 6)
    monkeypatch.setattr(blobs, "KEEP_DAYS", 30)


def purge_now():
    conn = db.connect()
    try:
        return blobs.purge(conn)
    finally:
        conn.close()
