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


def test_a_finished_file_is_not_dropped_by_the_unfinished_rule(client):
    a = signup(client, "alice")
    blob_id = upload(a, [b"x" * 50])
    age(blob_id, "-7 hours")
    assert purge_now() == 0
    assert a.get(f"/api/blobs/{blob_id}/pieces/0").status_code == 200


def test_housekeeping_runs_in_the_background_once_an_hour(client, monkeypatch):
    jobs = []
    monkeypatch.setattr(blobs, "_spawn", jobs.append)
    monkeypatch.setattr(blobs, "_last_purge", float("-inf"))
    blobs.housekeeping()
    blobs.housekeeping()
    assert jobs == [blobs._purge_in_background]


def test_a_request_never_waits_for_the_clean_up(client, monkeypatch):
    jobs = []
    monkeypatch.setattr(blobs, "_spawn", jobs.append)
    monkeypatch.setattr(blobs, "_last_purge", float("-inf"))
    monkeypatch.setattr(blobs, "purge", lambda conn: pytest.fail("purged inside a request"))
    a = signup(client, "alice")
    assert start(a, 1, 50).status_code == 200
    assert len(jobs) == 1


def test_the_background_job_removes_old_files(client, tmp_path):
    a = signup(client, "alice")
    blob_id = upload(a, [b"x" * 50])
    age(blob_id, "-31 days")
    blobs._purge_in_background()
    assert not (tmp_path / "blobs" / blob_id).exists()
