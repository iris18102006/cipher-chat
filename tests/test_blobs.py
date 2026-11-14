import pytest

from backend import db, main
from tests.test_backend import signup

blobs = main.blobs  # blobs.py can only be imported after main, so reach it through main

PIECE = 64  # tiny pieces, so the tests don't need megabytes
CT = PIECE + blobs.TAG  # what one full piece weighs once it is locked
RAW = {"Content-Type": "application/octet-stream"}


@pytest.fixture(autouse=True)
def small_files(tmp_path, monkeypatch):
    monkeypatch.setattr(blobs, "BLOB_DIR", tmp_path / "blobs")
    monkeypatch.setattr(blobs, "CHUNK", PIECE)
    monkeypatch.setattr(blobs, "CHUNK_CT", CT)
    monkeypatch.setattr(blobs, "MAX_FILE", PIECE * 8)


def start(c, pieces, size):
    return c.post("/api/blobs", json={"pieces": pieces, "size": size})


def piece(c, blob_id, index, data):
    return c.put(f"/api/blobs/{blob_id}/pieces/{index}", content=data, headers=RAW)


def test_a_new_file_gets_a_random_id(client):
    a = signup(client, "alice")
    first = start(a, 1, 50)
    assert first.status_code == 200
    assert len(first.json()["id"]) == 32
    assert start(a, 1, 50).json()["id"] != first.json()["id"]


def test_making_room_for_a_file_needs_login(client):
    assert start(client, 1, 50).status_code == 401


@pytest.mark.parametrize(
    "pieces, size, status",
    [
        (2, CT + 20, 200),  # one full piece and a short one
        (2, CT + 5, 400),  # the last piece is smaller than the lock alone
        (1, CT, 200),  # exactly one full piece
        (2, CT, 400),  # the last piece would be empty
        (2, CT + CT + 1, 400),  # the last piece would be too big
        (1, CT + 1, 400),
        (1, 10, 422),  # smaller than the lock alone
        (0, 50, 422),
    ],
)
def test_a_file_has_to_be_cut_the_right_way(client, pieces, size, status):
    a = signup(client, "alice")
    assert start(a, pieces, size).status_code == status


def test_the_size_limit(client):
    a = signup(client, "alice")
    assert start(a, 8, 8 * CT).status_code == 200  # exactly the limit
    assert start(a, 9, 8 * CT + 20).status_code == 413


def test_the_storage_limit_for_one_person(client, monkeypatch):
    monkeypatch.setattr(blobs, "QUOTA", 2 * CT)
    a = signup(client, "alice")
    b = signup(client, "bob")
    assert start(a, 1, CT).status_code == 200
    assert start(a, 1, CT).status_code == 200
    assert start(a, 1, CT).status_code == 413
    assert start(b, 1, CT).status_code == 200  # somebody else's space is separate


def upload(c, parts):
    """Sends a whole file, parts being the locked pieces."""
    blob_id = start(c, len(parts), sum(len(p) for p in parts)).json()["id"]
    for i, data in enumerate(parts):
        assert piece(c, blob_id, i, data).status_code == 200
    assert c.post(f"/api/blobs/{blob_id}/complete").json() == {"ok": True}
    return blob_id


def test_a_file_goes_up_and_comes_back(client):
    a = signup(client, "alice")
    b = signup(client, "bob")
    first, last = bytes(range(CT)), b"x" * 30
    blob_id = upload(a, [first, last])
    got = b.get(f"/api/blobs/{blob_id}/pieces/0")  # anybody logged in who knows the id
    assert got.status_code == 200
    assert got.content == first
    assert got.headers["content-type"] == "application/octet-stream"
    assert got.headers["x-content-type-options"] == "nosniff"
    assert a.get(f"/api/blobs/{blob_id}/pieces/1").content == last


def test_loading_a_piece_needs_login(client):
    a = signup(client, "alice")
    blob_id = upload(a, [b"x" * 30])
    assert client.get(f"/api/blobs/{blob_id}/pieces/0").status_code == 401


def test_finishing_twice_is_fine(client):
    a = signup(client, "alice")
    blob_id = upload(a, [b"x" * 30])
    assert a.post(f"/api/blobs/{blob_id}/complete").json() == {"ok": True}
