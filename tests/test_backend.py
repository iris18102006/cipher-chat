import base64
import os

import pytest
from fastapi.testclient import TestClient

from backend import db

PUB_A = base64.b64encode(b"\x04" + b"a" * 64).decode()
PUB_B = base64.b64encode(b"\x04" + b"b" * 64).decode()
ORIGIN = {"origin": "http://testserver", "host": "testserver"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.db")
    db.init_db()
    from backend import main

    main._fails.clear()
    main.manager.sockets.clear()
    with TestClient(main.app) as c:
        yield c


def signup(client, name, pw="password123"):
    c = TestClient(client.app)
    # real uvicorn runs every socket on one event loop; make the test clients
    # share one too, or cross-user sends would hop between loops and hang
    c.portal = client.portal
    r = c.post("/api/signup", json={"username": name, "password": pw})
    assert r.status_code == 200, r.text
    return c


def test_signup_validation(client):
    assert client.post("/api/signup", json={"username": "ab", "password": "password123"}).status_code == 400
    assert client.post("/api/signup", json={"username": "good_name", "password": "short"}).status_code == 400
    signup(client, "alice")
    assert client.post("/api/signup", json={"username": "ALICE", "password": "password123"}).status_code == 409


def test_login_and_wrong_password(client):
    signup(client, "alice")
    bad = client.post("/api/login", json={"username": "alice", "password": "nope-nope"})
    assert bad.status_code == 401
    ghost = client.post("/api/login", json={"username": "ghost", "password": "nope-nope"})
    assert ghost.status_code == 401 and ghost.json() == bad.json()


def test_login_rate_limit(client):
    signup(client, "alice")
    codes = [
        client.post("/api/login", json={"username": "alice", "password": "wrong-pass"}).status_code
        for _ in range(10)
    ]
    assert 429 in codes
    # even the right password is blocked while limited
    assert client.post("/api/login", json={"username": "alice", "password": "password123"}).status_code == 429


def test_index_redirects_when_logged_out(client):
    r = client.get("/", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/login.html"
    a = signup(client, "alice")
    assert a.get("/", follow_redirects=False).status_code == 200


def test_expired_session_rejected(client):
    from backend.db import connect

    a = signup(client, "alice")
    assert a.get("/api/me").status_code == 200
    conn = connect()
    conn.execute("UPDATE sessions SET created_at = datetime('now', '-31 days')")
    conn.commit()
    conn.close()
    assert a.get("/api/me").status_code == 401

