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


def test_an_unfinished_upload_is_dropped_after_six_hours(client, tmp_path):
    a = signup(client, "alice")
    blob_id = start(a, 1, 50).json()["id"]
    assert piece(a, blob_id, 0, b"x" * 50).status_code == 200
    age(blob_id, "-5 hours")
    assert purge_now() == 0
    age(blob_id, "-7 hours")
    assert purge_now() == 1
    assert not (tmp_path / "blobs" / blob_id).exists()
