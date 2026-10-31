import base64
import os
import re
from io import BytesIO
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

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


def make_image(fmt="PNG", size=(40, 30), frames=1):
    buf = BytesIO()
    if frames > 1:
        imgs = [Image.new("RGB", size, ((i * 40) % 255, 50, 90)) for i in range(frames)]
        imgs[0].save(buf, "GIF", save_all=True, append_images=imgs[1:], duration=80, loop=0)
    else:
        Image.new("RGB", size, (200, 30, 90)).save(buf, fmt)
    return buf.getvalue()


RAW = {"content-type": "application/octet-stream"}


def put_avatar(c, data):
    return c.put("/api/me/avatar", content=data, headers=RAW)


def add_photo(c, data):
    return c.post("/api/me/photos", content=data, headers=RAW)


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
    # strangers are not contacts; an exact username add creates the relationship first
    assert b.get("/api/contacts").json() == []
    b.post("/api/friends/alice")
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
    a.post("/api/friends/bob")
    b.post("/api/friends/alice/accept")
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
    a.post("/api/friends/bob")
    b.post("/api/friends/alice/accept")
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
    b.post("/api/friends/alice")
    with a.websocket_connect("/ws", headers=ORIGIN) as wa:
        wa.receive_json()
    people = b.get("/api/contacts").json()
    assert people[0]["online"] is False and people[0]["last_seen"]




def test_unrelated_users_never_appear_as_contacts(client):
    a, b, c = signup(client, "alice"), signup(client, "bob"), signup(client, "carol")
    assert a.get("/api/contacts").json() == []
    assert b.get("/api/contacts").json() == []
    c.post("/api/friends/alice")
    assert [row["username"] for row in a.get("/api/contacts").json()] == ["carol"]
    assert b.get("/api/contacts").json() == []


def test_custom_profile_style_is_saved_and_validated(client):
    a = signup(client, "alice")
    custom = {
        "page": "#110011", "card": "#220022", "text": "#ffeeff",
        "font": "comic", "pattern": "hearts", "border_style": "double",
        "border_width": 5, "radius": 12, "name_effect": "glow", "marquee": True,
    }
    r = a.put("/api/profile", json={"custom": custom})
    assert r.status_code == 200, r.text
    assert r.json()["custom"] == custom
    assert a.put("/api/profile", json={"custom": {"font": "javascript:evil"}}).status_code == 400
    assert a.put("/api/profile", json={"custom": {"page": "red"}}).status_code == 400
    assert a.put("/api/profile", json={"custom": {"border_width": 99}}).status_code == 400
    assert a.put("/api/profile", json={"custom": {"raw_css": "body{}"}}).status_code == 400


# ---------- profiles ----------


def test_profile_defaults_and_update(client):
    a = signup(client, "alice")
    p = a.get("/api/profile/alice").json()
    assert p["me"] is True and p["theme"] == "classic" and p["display_name"] == ""
    r = a.put(
        "/api/profile",
        json={"display_name": "  Ali  ", "mood": "happy", "about_me": "line1\nline2", "theme": "emo", "accent": "#FF00AA"},
    )
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["display_name"] == "Ali" and p["about_me"] == "line1\nline2"
    assert p["avatar"] == "" and p["theme"] == "emo" and p["accent"] == "#ff00aa"


def test_profile_partial_update_keeps_other_fields(client):
    a = signup(client, "alice")
    a.put("/api/profile", json={"mood": "chill", "song": "some song"})
    p = a.put("/api/profile", json={"mood": "busy"}).json()
    assert p["mood"] == "busy" and p["song"] == "some song"


def test_profile_validation(client):
    a = signup(client, "alice")
    assert a.put("/api/profile", json={"theme": "nope"}).status_code == 400
    assert a.put("/api/profile", json={"accent": "red"}).status_code == 400
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
    a.put("/api/profile", json={"display_name": "Ali"})
    avatar = put_avatar(a, make_image()).json()["avatar"]
    a.post("/api/friends/bob")
    row = b.get("/api/contacts").json()[0]
    assert row["display_name"] == "Ali" and row["avatar"] == avatar
    assert row["friend"] == "incoming" and row["blocked"] is False
    assert a.get("/api/contacts").json()[0]["friend"] == "outgoing"
    b.post("/api/blocks/alice")
    assert b.get("/api/contacts").json()[0]["blocked"] is True
    with b.websocket_connect("/ws", headers=ORIGIN) as wb:
        wb.receive_json()
        # once bob blocks alice, the friendship is removed. Alice does not get
        # a ghost contact or any presence information for bob.
        assert a.get("/api/contacts").json() == []


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


# ---------- top friends, visitors ----------


def befriend(a, b, an, bn):
    a.post(f"/api/friends/{bn}")
    b.post(f"/api/friends/{an}/accept")


def test_top_friends_must_be_friends_and_keep_order(client):
    a, b, c = signup(client, "alice"), signup(client, "bob"), signup(client, "carol")
    befriend(a, b, "alice", "bob")
    # carol is not a friend yet
    assert a.put("/api/profile", json={"top_friends": ["bob", "carol"]}).status_code == 400
    befriend(a, c, "alice", "carol")
    p = a.put("/api/profile", json={"top_friends": ["carol", "bob", "carol"]}).json()
    assert [f["username"] for f in p["top_friends"]] == ["carol", "bob"]


def test_top_friends_limit(client):
    a = signup(client, "alice")
    names = []
    for i in range(9):
        n = f"friend{i}"
        names.append(n)
        befriend(a, signup(client, n), "alice", n)
    assert a.put("/api/profile", json={"top_friends": names}).status_code == 400
    assert a.put("/api/profile", json={"top_friends": names[:8]}).status_code == 200


def test_top_friends_drop_out_after_unfriend_or_block(client):
    a, b, c = signup(client, "alice"), signup(client, "bob"), signup(client, "carol")
    befriend(a, b, "alice", "bob")
    befriend(a, c, "alice", "carol")
    a.put("/api/profile", json={"top_friends": ["bob", "carol"]})
    a.delete("/api/friends/bob")
    assert [f["username"] for f in c.get("/api/profile/alice").json()["top_friends"]] == ["carol"]
    # carol blocks herself out of what bob sees of alice's top friends
    befriend(a, b, "alice", "bob")
    a.put("/api/profile", json={"top_friends": ["bob", "carol"]})
    b.post("/api/blocks/carol")
    assert [f["username"] for f in b.get("/api/profile/alice").json()["top_friends"]] == ["bob"]


def test_visitor_counter_counts_people_not_refreshes(client):
    a, b, c = signup(client, "alice"), signup(client, "bob"), signup(client, "carol")
    for _ in range(3):
        b.get("/api/profile/alice")
    c.get("/api/profile/alice")
    assert a.get("/api/profile/alice").json()["visitors"] == 2
    # looking at your own profile doesn't count
    assert a.get("/api/profile/alice").json()["visitors"] == 2


def test_profile_shows_friend_status_and_mutual_friends(client):
    a, b, c = signup(client, "alice"), signup(client, "bob"), signup(client, "carol")
    befriend(a, c, "alice", "carol")
    befriend(b, c, "bob", "carol")
    p = b.get("/api/profile/alice").json()
    assert p["friend"] == "none" and p["mutual_friends"] == 1 and p["friend_count"] == 1
    a.post("/api/friends/bob")
    assert b.get("/api/profile/alice").json()["friend"] == "incoming"


# ---------- live social events ----------


def test_friend_events_pushed_live(client):
    a, b = signup(client, "alice"), signup(client, "bob")
    with b.websocket_connect("/ws", headers=ORIGIN) as wb:
        assert wb.receive_json()["type"] == "ready"
        a.post("/api/friends/bob")
        assert wb.receive_json() == {"type": "social", "event": "request", "from": "alice"}
        a.delete("/api/friends/bob")
        assert wb.receive_json() == {"type": "social", "event": "removed", "from": "alice"}
    a.post("/api/friends/bob")
    with a.websocket_connect("/ws", headers=ORIGIN) as wa:
        assert wa.receive_json()["type"] == "ready"
        b.post("/api/friends/alice/accept")
        assert wa.receive_json() == {"type": "social", "event": "accepted", "from": "bob"}


def test_block_sends_a_neutral_refresh_to_both_sides(client):
    a, b = signup(client, "alice"), signup(client, "bob")
    with b.websocket_connect("/ws", headers=ORIGIN) as wb:
        wb.receive_json()
        a.post("/api/blocks/bob")
        # bob only learns to refresh, the frame doesn't say anyone was blocked
        assert wb.receive_json() == {"type": "social", "event": "refresh", "from": "alice"}


def test_me_includes_display_name_and_avatar(client):
    a = signup(client, "alice")
    a.put("/api/profile", json={"display_name": "Ali"})
    assert a.get("/api/me").json() == {"username": "alice", "display_name": "Ali", "avatar": ""}
    avatar = put_avatar(a, make_image()).json()["avatar"]
    assert a.get("/api/me").json() == {"username": "alice", "display_name": "Ali", "avatar": avatar}




def test_profile_wall_post_and_delete_permissions(client):
    a, b, c = signup(client, "alice"), signup(client, "bob"), signup(client, "carol")
    r = b.post("/api/profile/alice/wall", json={"body": " hi alice! "})
    assert r.status_code == 200, r.text
    comment_id = r.json()["id"]
    wall = a.get("/api/profile/alice").json()["wall"]
    assert wall[0]["body"] == "hi alice!" and wall[0]["username"] == "bob"
    assert c.delete(f"/api/profile/alice/wall/{comment_id}").status_code == 403
    assert a.delete(f"/api/profile/alice/wall/{comment_id}").status_code == 200
    assert a.get("/api/profile/alice").json()["wall"] == []


def test_profile_wall_respects_blocks(client):
    a, b = signup(client, "alice"), signup(client, "bob")
    a.post("/api/blocks/bob")
    assert b.post("/api/profile/alice/wall", json={"body": "nope"}).status_code == 404


# ---------- the frontend and backend agree ----------

WEB = Path(__file__).parent.parent / "web"


def test_every_theme_has_css_and_a_picker_button():
    from backend import main

    css = (WEB / "themes.css").read_text()
    js = (WEB / "profile.js").read_text()
    block = js.split("const THEME_CHOICES = [", 1)[1].split("];", 1)[0]
    in_js = re.findall(r'\["([a-z]+)",\s*"', block)
    for theme in main.THEMES:
        assert f"#profile-card.theme-{theme}" in css, f"themes.css is missing {theme}"
        assert f".pf-swatch.theme-{theme}" in css, f"themes.css has no picker preview for {theme}"
    assert sorted(in_js) == sorted(main.THEMES)


def test_every_accent_in_the_picker_is_a_valid_colour():
    from backend import main

    js = (WEB / "profile.js").read_text()
    line = [l for l in js.splitlines() if l.startswith("const ACCENTS")][0]
    colours = re.findall(r'"(#[0-9a-fA-F]+)"', line)
    assert colours
    assert all(main.ACCENT_RE.match(c) for c in colours)


def test_the_web_files_have_no_emoji():
    # profile pictures are uploaded photos now, nothing in the ui should be an emoji
    bad = re.compile("[\U0001F000-\U0001FAFF\u2190-\u2BFF\uFE0F]")
    for path in WEB.iterdir():
        if path.suffix in (".js", ".html", ".css"):
            found = bad.findall(path.read_text())
            assert not found, f"{path.name} has emoji: {found[:5]}"


def test_every_style_option_has_a_button_in_the_editor():
    from backend import main

    js = (WEB / "profile.js").read_text()
    for key, values in main.CUSTOM_CHOICES.items():
        for value in values:
            assert f'"{value}"' in js, f"the editor has no button for {key} = {value}"


# ---------- pictures ----------


def test_avatar_upload_is_resized_and_served(client):
    a = signup(client, "alice")
    r = put_avatar(a, make_image("PNG", size=(1000, 600)))
    assert r.status_code == 200, r.text
    url = r.json()["avatar"]
    assert url.startswith("/api/img/")
    img = a.get(url)
    assert img.status_code == 200 and img.headers["content-type"] == "image/webp"
    assert img.headers["x-content-type-options"] == "nosniff"
    assert Image.open(BytesIO(img.content)).size == (320, 320)
    assert a.get("/api/profile/alice").json()["avatar"] == url
    # a new one replaces the old one for good
    new = put_avatar(a, make_image("JPEG")).json()["avatar"]
    assert new != url and a.get(url).status_code == 404
    gone = a.delete("/api/me/avatar").json()
    assert gone["avatar"] == "" and a.get(new).status_code == 404


def test_uploads_must_be_real_pictures(client):
    a = signup(client, "alice")
    bad = [
        b"",
        b"hello there",
        b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        b"<html><script>alert(1)</script></html>",
        b"GIF89a" + b"\x00" * 4,  # looks like a gif for a second, then isn't
        make_image("BMP"),  # a real picture, but not one of the allowed kinds
    ]
    for data in bad:
        assert put_avatar(a, data).status_code == 400, data[:20]
        assert add_photo(a, data).status_code == 400, data[:20]
    assert a.get("/api/profile/alice").json()["photos"] == []


def test_upload_size_limit(client):
    a = signup(client, "alice")
    assert put_avatar(a, b"x" * (5 * 1024 * 1024 + 1)).status_code == 413
    assert add_photo(a, b"x" * (4 * 1024 * 1024 + 1)).status_code == 413
    # too many pixels, even though the file itself is tiny
    assert add_photo(a, make_image("PNG", size=(9000, 10))).status_code == 400


def test_pictures_need_a_login(client):
    a = signup(client, "alice")
    url = put_avatar(a, make_image()).json()["avatar"]
    assert client.get(url).status_code == 401
    assert client.put("/api/me/avatar", content=make_image(), headers=RAW).status_code == 401


def test_photo_metadata_is_stripped(client):
    a = signup(client, "alice")
    img = Image.new("RGB", (50, 50), (10, 200, 10))
    exif = Image.Exif()
    exif[0x010F] = "secret camera make"
    buf = BytesIO()
    img.save(buf, "JPEG", exif=exif)
    assert b"secret camera make" in buf.getvalue()
    photos = add_photo(a, buf.getvalue()).json()["photos"]
    served = a.get(photos[0]["url"]).content
    assert b"secret camera make" not in served
    assert len(Image.open(BytesIO(served)).getexif()) == 0


def test_gallery_add_caption_delete_and_limit(client):
    a = signup(client, "alice")
    big = add_photo(a, make_image("PNG", size=(3000, 2000))).json()["photos"][0]
    assert max(big["width"], big["height"]) == 1600 and not big["animated"]
    gif = make_image(frames=4)
    photos = add_photo(a, gif).json()["photos"]
    moving = photos[1]
    assert moving["animated"] is True
    # animated gifs are kept byte for byte so they keep moving
    served = a.get(moving["url"])
    assert served.headers["content-type"] == "image/gif" and served.content == gif
    cap = a.patch(f"/api/me/photos/{moving['id']}", json={"caption": "  my cat  "})
    assert cap.json()["photos"][1]["caption"] == "my cat"
    assert a.patch(f"/api/me/photos/{moving['id']}", json={"caption": "x" * 61}).status_code == 400
    for _ in range(10):
        assert add_photo(a, make_image()).status_code == 200
    assert add_photo(a, make_image()).status_code == 400  # 12 is the limit
    left = a.delete(f"/api/me/photos/{big['id']}").json()["photos"]
    assert len(left) == 11 and a.get(big["url"]).status_code == 404
    assert add_photo(a, make_image()).status_code == 200


def test_you_can_only_touch_your_own_photos(client):
    a, b = signup(client, "alice"), signup(client, "bob")
    photo = add_photo(a, make_image()).json()["photos"][0]
    assert b.delete(f"/api/me/photos/{photo['id']}").status_code == 400
    assert b.patch(f"/api/me/photos/{photo['id']}", json={"caption": "mine now"}).status_code == 400
    assert a.get(photo["url"]).status_code == 200
    # but anyone logged in can see them on her profile
    assert b.get("/api/profile/alice").json()["photos"][0]["id"] == photo["id"]
    assert b.get(photo["url"]).status_code == 200


def test_stickers_and_background(client):
    a, b = signup(client, "alice"), signup(client, "bob")
    one = add_photo(a, make_image()).json()["photos"][0]
    two = add_photo(a, make_image(frames=3)).json()["photos"][1]
    theirs = add_photo(b, make_image()).json()["photos"][0]
    stickers = [
        {"img": one["id"], "x": 10, "y": 20.556, "w": 18, "r": -10},
        {"img": two["id"], "x": 90, "y": 95, "w": 30},
    ]
    r = a.put("/api/profile", json={"stickers": stickers, "bg_image": one["id"], "custom": {"bg_mode": "cover", "avatar_shape": "hexagon", "font": "script"}})
    assert r.status_code == 200, r.text
    p = r.json()
    assert [s["img"] for s in p["stickers"]] == [one["id"], two["id"]]
    assert p["stickers"][0]["url"] == one["url"] and p["stickers"][0]["y"] == 20.56
    assert p["stickers"][1]["r"] == 0
    assert p["bg_image"] == one["id"] and p["bg_url"] == one["url"]
    assert p["custom"]["avatar_shape"] == "hexagon"
    # other people see the same thing
    seen = b.get("/api/profile/alice").json()
    assert len(seen["stickers"]) == 2 and seen["bg_url"] == one["url"]
    bad = [
        [{"img": theirs["id"], "x": 5, "y": 5, "w": 10}],  # somebody else's picture
        [{"img": 99999, "x": 5, "y": 5, "w": 10}],
        [{"img": one["id"], "x": 101, "y": 5, "w": 10}],
        [{"img": one["id"], "x": 5, "y": -1, "w": 10}],
        [{"img": one["id"], "x": 5, "y": 5, "w": 3}],
        [{"img": one["id"], "x": 5, "y": 5, "w": 46}],
        [{"img": one["id"], "x": 5, "y": 5, "w": 10, "r": 90}],
        [{"img": one["id"], "x": 5, "y": 5, "w": 10}] * 9,
    ]
    for body in bad:
        assert a.put("/api/profile", json={"stickers": body}).status_code == 400, body
    assert a.put("/api/profile", json={"bg_image": theirs["id"]}).status_code == 400
    # nothing changed after all those failures
    assert len(a.get("/api/profile/alice").json()["stickers"]) == 2
    assert a.put("/api/profile", json={"stickers": [], "bg_image": 0}).json()["bg_url"] == ""


def test_deleting_a_picture_removes_its_stickers_and_background(client):
    a = signup(client, "alice")
    one = add_photo(a, make_image()).json()["photos"][0]
    two = add_photo(a, make_image()).json()["photos"][1]
    a.put("/api/profile", json={"bg_image": one["id"], "stickers": [
        {"img": one["id"], "x": 5, "y": 5, "w": 10}, {"img": two["id"], "x": 50, "y": 50, "w": 10}]})
    after = a.delete(f"/api/me/photos/{one['id']}").json()
    assert after["bg_image"] == 0 and [s["img"] for s in after["stickers"]] == [two["id"]]
    assert [s["img"] for s in a.get("/api/profile/alice").json()["stickers"]] == [two["id"]]


def test_someone_who_blocked_you_does_not_show_you_their_pictures(client):
    a, b, c = signup(client, "alice"), signup(client, "bob"), signup(client, "carol")
    url = put_avatar(a, make_image()).json()["avatar"]
    a.post("/api/blocks/bob")
    assert b.get(url).status_code == 404
    assert a.get(url).status_code == 200 and c.get(url).status_code == 200


def test_bad_custom_style_values_still_rejected(client):
    a = signup(client, "alice")
    for custom in ({"avatar_shape": "star"}, {"bg_mode": "fixed"}, {"font": "papyrus"}):
        assert a.put("/api/profile", json={"custom": custom}).status_code == 400
