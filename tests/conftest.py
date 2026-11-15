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
    main.manager.sockets.clear()
    with TestClient(main.app) as c:
        yield c
