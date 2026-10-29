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


def test_key_upload_validation(client):
    a = signup(client, "alice")
    assert a.put("/api/key", json={"pub": "nope"}).status_code == 400
    assert a.put("/api/key", json={"pub": PUB_A}).status_code == 200
    b = signup(client, "bob")
    people = b.get("/api/contacts").json()
    assert people[0]["username"] == "alice" and people[0]["pub"] == PUB_A


def test_ws_rejects_anonymous_and_cross_origin(client):
    with pytest.raises(Exception):
        with client.websocket_connect("/ws", headers=ORIGIN):
            pass
    a = signup(client, "alice")
    with pytest.raises(Exception):
        with a.websocket_connect("/ws", headers={"origin": "http://evil.example", "host": "testserver"}):
            pass


def test_message_flow_receipts_and_history(client):
    a, b = signup(client, "alice"), signup(client, "bob")
    with a.websocket_connect("/ws", headers=ORIGIN) as wa:
        assert wa.receive_json()["type"] == "ready"
        with b.websocket_connect("/ws", headers=ORIGIN) as wb:
            assert wa.receive_json() == {"type": "presence", "user": "bob", "online": True}
            assert wb.receive_json()["type"] == "ready"

            wa.send_json({"type": "typing", "to": "bob", "state": True})
            assert wb.receive_json() == {"type": "typing", "from": "alice", "state": True}

            wa.send_json({"type": "msg", "to": "bob", "iv": "aXY=", "ct": "Y3Q=", "cid": "c1"})
            got = wb.receive_json()
            assert got["type"] == "msg" and got["from"] == "alice" and got["cid"] == "c1"
            echo = wa.receive_json()
            assert echo["id"] == got["id"] and echo["delivered"] is True

            wb.send_json({"type": "read", "to": "alice"})
            assert wa.receive_json() == {"type": "read", "by": "bob", "ids": [got["id"]]}
            assert wb.receive_json()["type"] == "read-sync"

    hist = a.get("/api/messages/bob").json()
    assert len(hist) == 1 and hist[0]["read"] and hist[0]["delivered"]
    assert hist[0]["ct"] == "Y3Q="  # server only ever holds ciphertext


def test_offline_message_delivered_on_connect(client):
    a, b = signup(client, "alice"), signup(client, "bob")
    with a.websocket_connect("/ws", headers=ORIGIN) as wa:
        wa.receive_json()
        wa.send_json({"type": "msg", "to": "bob", "iv": "aXY=", "ct": "Y3Q="})
        assert wa.receive_json()["delivered"] is False
        with b.websocket_connect("/ws", headers=ORIGIN) as wb:
            receipt = wa.receive_json()
            if receipt["type"] == "presence":
                receipt = wa.receive_json()
            assert receipt["type"] == "receipt" and receipt["status"] == "delivered"
            assert wb.receive_json()["type"] == "ready"
    assert b.get("/api/contacts").json()[0]["unread"] == 1


def test_oversized_and_self_messages_dropped(client):
    a = signup(client, "alice")
    signup(client, "bob")
    with a.websocket_connect("/ws", headers=ORIGIN) as wa:
        wa.receive_json()
        wa.send_json({"type": "msg", "to": "bob", "iv": "aXY=", "ct": "x" * 20000})
        wa.send_json({"type": "msg", "to": "alice", "iv": "aXY=", "ct": "Y3Q="})
        wa.send_json({"type": "ping"})
        assert wa.receive_json() == {"type": "pong"}
    assert a.get("/api/messages/bob").json() == []


def test_last_seen_set_on_disconnect(client):
    a, b = signup(client, "alice"), signup(client, "bob")
    with a.websocket_connect("/ws", headers=ORIGIN) as wa:
        wa.receive_json()
    people = b.get("/api/contacts").json()
    assert people[0]["online"] is False and people[0]["last_seen"]


# ---------- profiles ----------


def test_profile_defaults_and_update(client):
    a = signup(client, "alice")
    p = a.get("/api/profile/alice").json()
    assert p["me"] is True and p["theme"] == "classic" and p["display_name"] == ""
    r = a.put(
        "/api/profile",
        json={"display_name": "  Ali  ", "mood": "happy", "about_me": "line1\nline2", "avatar": "🦄", "theme": "emo", "accent": "#FF00AA"},
    )
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["display_name"] == "Ali" and p["about_me"] == "line1\nline2"
    assert p["avatar"] == "🦄" and p["theme"] == "emo" and p["accent"] == "#ff00aa"


def test_profile_partial_update_keeps_other_fields(client):
    a = signup(client, "alice")
    a.put("/api/profile", json={"mood": "chill", "song": "some song"})
    p = a.put("/api/profile", json={"mood": "busy"}).json()
    assert p["mood"] == "busy" and p["song"] == "some song"


def test_profile_validation(client):
    a = signup(client, "alice")
    assert a.put("/api/profile", json={"theme": "nope"}).status_code == 400
    assert a.put("/api/profile", json={"accent": "red"}).status_code == 400
    assert a.put("/api/profile", json={"avatar": "abc"}).status_code == 400
    assert a.put("/api/profile", json={"display_name": "x" * 31}).status_code == 400
    assert a.put("/api/profile", json={"about_me": "x" * 601}).status_code == 400
    # an empty accent resets back to the theme colour
    assert a.put("/api/profile", json={"accent": ""}).status_code == 200


def test_profile_text_is_stored_as_plain_text(client):
    a = signup(client, "alice")
    p = a.put("/api/profile", json={"headline": "<script>x</script>\x00hi"}).json()
    # stored as typed (minus control chars), the browser renders it with textContent
    assert p["headline"] == "<script>x</script>hi"


def test_view_someone_elses_profile(client):
    a, b = signup(client, "alice"), signup(client, "bob")
    a.put("/api/profile", json={"headline": "hello world"})
    p = b.get("/api/profile/alice").json()
    assert p["headline"] == "hello world" and p["me"] is False
    assert b.get("/api/profile/ghost").status_code == 404
    assert client.get("/api/profile/alice").status_code == 401
    assert b.put("/api/profile", json={"mood": "x"}).status_code == 200
