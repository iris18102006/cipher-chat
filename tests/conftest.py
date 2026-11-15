import pytest
from fastapi.testclient import TestClient

from backend import db


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.db")
    db.init_db()
    from backend import main

    main._fails.clear()
    main.ip_fail_limiter.clear()
    main.signup_limiter.clear()
    # plenty of tests make lots of accounts from one address, the limits get their own tests
    monkeypatch.setattr(main.ip_fail_limiter, "limit", 10**6)
    monkeypatch.setattr(main.signup_limiter, "limit", 10**6)
    # the clean-up thread would open the database of whichever test happens to be running
    monkeypatch.setattr(main.blobs, "_spawn", lambda job: None)
    main.manager.sockets.clear()
    with TestClient(main.app) as c:
        yield c
