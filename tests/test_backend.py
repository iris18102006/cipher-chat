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


# ---------- friends ----------


def test_friend_request_flow(client):
    a, b = signup(client, "alice"), signup(client, "bob")
    assert a.post("/api/friends/bob").json() == {"status": "outgoing"}
    # asking twice changes nothing
    assert a.post("/api/friends/bob").json() == {"status": "outgoing"}
    assert [x["username"] for x in a.get("/api/friends").json()["outgoing"]] == ["bob"]
    assert [x["username"] for x in b.get("/api/friends").json()["incoming"]] == ["alice"]
    assert b.post("/api/friends/alice/accept").json() == {"status": "friends"}
    assert [x["username"] for x in a.get("/api/friends").json()["friends"]] == ["bob"]
    assert [x["username"] for x in b.get("/api/friends").json()["friends"]] == ["alice"]


def test_friend_request_both_ways_becomes_friendship(client):
    a, b = signup(client, "alice"), signup(client, "bob")
    a.post("/api/friends/bob")
    assert b.post("/api/friends/alice").json() == {"status": "friends"}


def test_only_the_addressee_can_accept(client):
    a, b = signup(client, "alice"), signup(client, "bob")
    a.post("/api/friends/bob")
    assert a.post("/api/friends/bob/accept").status_code == 404
    assert b.post("/api/friends/alice/accept").status_code == 200
    # accepting again is harmless
    assert b.post("/api/friends/alice/accept").status_code == 200


def test_decline_cancel_and_unfriend(client):
    a, b = signup(client, "alice"), signup(client, "bob")
    a.post("/api/friends/bob")
    assert b.delete("/api/friends/alice").json() == {"status": "none"}
    assert a.get("/api/friends").json() == {"friends": [], "incoming": [], "outgoing": []}
    a.post("/api/friends/bob")
    assert a.delete("/api/friends/bob").status_code == 200  # cancel
    a.post("/api/friends/bob")
    b.post("/api/friends/alice/accept")
    assert a.delete("/api/friends/bob").status_code == 200  # unfriend
    assert b.get("/api/friends").json()["friends"] == []


def test_friend_edge_cases(client):
    a = signup(client, "alice")
    assert a.post("/api/friends/alice").status_code == 400
    assert a.post("/api/friends/ghost").status_code == 404
    assert client.post("/api/friends/alice").status_code == 401


# ---------- blocking ----------


def test_block_unblock_and_list(client):
    a, b = signup(client, "alice"), signup(client, "bob")
    a.post("/api/friends/bob")
    b.post("/api/friends/alice/accept")
    assert a.post("/api/blocks/bob").json() == {"blocked": True}
    assert [x["username"] for x in a.get("/api/blocks").json()] == ["bob"]
    # blocking ends the friendship for both
    assert a.get("/api/friends").json()["friends"] == []
    assert b.get("/api/friends").json()["friends"] == []
    assert a.post("/api/blocks/bob").status_code == 200  # blocking twice is fine
    assert a.delete("/api/blocks/bob").json() == {"blocked": False}
    assert a.get("/api/blocks").json() == []
    assert a.post("/api/blocks/alice").status_code == 400


def test_friend_requests_cant_cross_a_block(client):
    a, b = signup(client, "alice"), signup(client, "bob")
    a.post("/api/blocks/bob")
    assert a.post("/api/friends/bob").status_code == 403
    assert b.post("/api/friends/alice").status_code == 403


def test_blocked_user_cant_see_profile_blocker_still_can(client):
    a, b = signup(client, "alice"), signup(client, "bob")
    a.post("/api/blocks/bob")
    assert b.get("/api/profile/alice").status_code == 404
    p = a.get("/api/profile/bob").json()
    assert p["blocked"] is True


def test_contacts_show_relationship_and_hide_presence_from_blockers(client):
    a, b = signup(client, "alice"), signup(client, "bob")
    a.put("/api/profile", json={"display_name": "Ali", "avatar": "🦄"})
    a.post("/api/friends/bob")
    row = b.get("/api/contacts").json()[0]
    assert row["display_name"] == "Ali" and row["avatar"] == "🦄"
    assert row["friend"] == "incoming" and row["blocked"] is False
    assert a.get("/api/contacts").json()[0]["friend"] == "outgoing"
    b.post("/api/blocks/alice")
    assert b.get("/api/contacts").json()[0]["blocked"] is True
    with b.websocket_connect("/ws", headers=ORIGIN) as wb:
        wb.receive_json()
        seen = a.get("/api/contacts").json()[0]
        assert seen["online"] is False and seen["last_seen"] is None


def test_messages_to_someone_who_blocked_you_are_hidden(client):
    a, b = signup(client, "alice"), signup(client, "bob")
    b.post("/api/blocks/alice")
    with a.websocket_connect("/ws", headers=ORIGIN) as wa:
        wa.receive_json()
        with b.websocket_connect("/ws", headers=ORIGIN) as wb:
            wb.receive_json()
            wa.send_json({"type": "typing", "to": "bob", "state": True})
            wa.send_json({"type": "msg", "to": "bob", "iv": "aXY=", "ct": "Y3Q="})
            echo = wa.receive_json()
            # alice isn't told anything, it just looks sent
            assert echo["type"] == "msg" and echo["delivered"] is False
            # bob's socket got nothing, the next frame he sees is his own pong
            wb.send_json({"type": "ping"})
            assert wb.receive_json() == {"type": "pong"}
    assert len(a.get("/api/messages/bob").json()) == 1
    assert b.get("/api/messages/alice").json() == []
    assert b.get("/api/contacts").json()[0]["unread"] == 0


def test_cant_send_to_someone_you_blocked(client):
    a, b = signup(client, "alice"), signup(client, "bob")
    a.post("/api/blocks/bob")
    with a.websocket_connect("/ws", headers=ORIGIN) as wa:
        wa.receive_json()
        wa.send_json({"type": "msg", "to": "bob", "iv": "aXY=", "ct": "Y3Q="})
        wa.send_json({"type": "ping"})
        assert wa.receive_json() == {"type": "pong"}
    assert a.get("/api/messages/bob").json() == []


def test_unblocking_does_not_reveal_old_hidden_messages(client):
    a, b = signup(client, "alice"), signup(client, "bob")
    b.post("/api/blocks/alice")
    with a.websocket_connect("/ws", headers=ORIGIN) as wa:
        wa.receive_json()
        wa.send_json({"type": "msg", "to": "bob", "iv": "aXY=", "ct": "Y3Q="})
        wa.receive_json()
    b.delete("/api/blocks/alice")
    assert b.get("/api/messages/alice").json() == []
