import os

import pytest

from backend import main
from tests.test_backend import signup

blobs = main.blobs
MB = 1024 * 1024

# these check the numbers the server starts with, so they step aside if somebody changed them on purpose
pytestmark = pytest.mark.skipif(
    any(name in os.environ for name in ("CIPHER_MAX_FILE_MB", "CIPHER_QUOTA_MB", "CIPHER_FILE_DAYS")),
    reason="the file limits were changed on purpose",
)


@pytest.fixture(autouse=True)
def blob_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(blobs, "BLOB_DIR", tmp_path / "blobs")


def test_the_limits_start_like_whatsapp_documents():
    assert blobs.MAX_FILE == 2048 * MB
    assert blobs.QUOTA == 10240 * MB
    assert blobs.KEEP_DAYS == 30


def test_a_2_gb_file_is_allowed(client):
    a = signup(client, "alice")
    full = blobs.MAX_FILE // blobs.CHUNK  # 512 pieces of 4 MB
    r = a.post("/api/blobs", json={"pieces": full, "size": full * blobs.CHUNK_CT})
    assert r.status_code == 200


def test_one_byte_more_than_2_gb_is_refused(client):
    a = signup(client, "alice")
    full = blobs.MAX_FILE // blobs.CHUNK
    r = a.post("/api/blobs", json={"pieces": full + 1, "size": full * blobs.CHUNK_CT + blobs.TAG + 1})
    assert r.status_code == 413
