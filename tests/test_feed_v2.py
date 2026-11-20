"""The feed's second round: audiences, edits, media, likes names, reposts rules, reports, close friends."""
import pytest

from backend import main, moderation
from tests.test_backend import make_image, signup
from tests.test_groups import trio
from backend import gifs, media


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    main.feed._recent.clear()
    media.upload_limiter.clear()
    gifs.search_limiter.clear()
    gifs.media_limiter.clear()
    monkeypatch.delenv("CIPHER_ADMINS", raising=False)
    monkeypatch.delenv("CIPHER_GIPHY_KEY", raising=False)
    monkeypatch.delenv("CIPHER_IMAGE_CHECK", raising=False)


def post(c, text="hi", **extra):
    return c.post("/api/posts", json={"body": text, **extra})


def ids(c, **q):
    return [p["id"] for p in c.get("/api/feed", params=q).json()["posts"]]


def png(c):
    r = c.post("/api/post-media", content=make_image("PNG").getvalue() if hasattr(make_image("PNG"), "getvalue") else make_image("PNG"))
    assert r.status_code == 200, r.text
    return r.json()


# ---------- audiences ----------

def test_close_friends_only_see_close_posts(client):
    a, b, c = trio(client)
    assert a.put("/api/close-friends", json={"usernames": ["bob"]}).status_code == 200
    pid = post(a, "secret", audience="close").json()["id"]
    assert pid in ids(b) and pid not in ids(c)
    assert pid in ids(a, tab="close") and pid in ids(b, tab="close")
    assert c.get(f"/api/posts/{pid}").status_code == 404


def test_only_me_is_only_me(client):
    a, b, c = trio(client)
    pid = post(a, "diary", audience="me").json()["id"]
    assert pid in ids(a) and pid not in ids(b)
    assert b.get(f"/api/posts/{pid}").status_code == 404


def test_close_friends_must_be_friends_and_go_with_the_friendship(client):
    a, b, c = trio(client)
    assert b.put("/api/close-friends", json={"usernames": ["carol"]}).status_code == 400
    a.put("/api/close-friends", json={"usernames": ["bob", "carol"]})
    assert [f["close"] for f in a.get("/api/close-friends").json()["friends"]] == [True, True]
    a.delete("/api/friends/bob")
    assert [f["username"] for f in a.get("/api/close-friends").json()["friends"]] == ["carol"]
    a.post("/api/friends/bob"); b.post("/api/friends/alice/accept")
    assert [f["close"] for f in a.get("/api/close-friends").json()["friends"]] == [False, True]


def test_default_audience_comes_from_settings(client):
    a, b, c = trio(client)
    assert a.put("/api/settings", json={"post_audience": "me"}).json()["post_audience"] == "me"
    assert post(a).json()["audience"] == "me"
    assert post(a, audience="friends").json()["audience"] == "friends"
    assert a.put("/api/settings", json={"post_audience": "nope"}).status_code == 400
    assert post(a, audience="everyone").status_code == 400


# ---------- editing ----------

def test_edit_own_post(client):
    a, b, c = trio(client)
    pid = post(a, "first").json()["id"]
    e = a.patch(f"/api/posts/{pid}", json={"body": "second"}).json()
    assert e["body"] == "second" and e["edited"] is True
    assert b.patch(f"/api/posts/{pid}", json={"body": "hax"}).status_code == 404
    assert a.patch(f"/api/posts/{pid}", json={"body": "  "}).status_code == 400


def test_changing_audience_is_not_an_edit(client):
    a, b, c = trio(client)
    pid = post(a, "x").json()["id"]
    e = a.patch(f"/api/posts/{pid}", json={"audience": "me"}).json()
    assert e["edited"] is False and pid not in ids(b)


def test_words_are_checked(client):
    a, b, c = trio(client)
    assert post(a, "i will kill you").status_code == 400
    assert post(a, "go kill yourself").status_code == 400
    assert post(a, "I'm gonna kill you").status_code == 400
    assert post(a, "this song kills me, killer beat").status_code == 200
    pid = post(a, "ok").json()["id"]
    assert a.patch(f"/api/posts/{pid}", json={"body": "kys"}).status_code == 400


# ---------- media ----------

def test_picture_upload_attach_and_serve(client):
    a, b, c = trio(client)
    m = png(a)
    assert m["kind"] == "image"
    # a draft is only for its owner
    assert b.get(m["url"]).status_code == 404 and a.get(m["url"]).status_code == 200
    p = post(a, "", media=[m["id"]]).json()
    assert p["media"][0]["id"] == m["id"]
    r = b.get(m["url"])
    assert r.status_code == 200 and r.headers["content-type"] == "image/webp"
    assert "sandbox" in r.headers["content-security-policy"]
    stranger = signup(client, "dave")
    assert stranger.get(m["url"]).status_code == 404  # not a friend of alice
    # used files can't go on a second post
    assert post(a, "again", media=[m["id"]]).status_code == 400


def test_media_follows_post_audience_and_deletion(client):
    a, b, c = trio(client)
    m = png(a)
    pid = post(a, "", media=[m["id"]], audience="me").json()["id"]
    assert b.get(m["url"]).status_code == 404
    a.patch(f"/api/posts/{pid}", json={"audience": "friends"})
    assert b.get(m["url"]).status_code == 200
    a.delete(f"/api/posts/{pid}")
    assert a.get(m["url"]).status_code == 404


def test_not_a_picture_is_refused(client):
    a, b, c = trio(client)
    assert a.post("/api/post-media", content=b"MZ" + b"\x00" * 3000).status_code == 400
    assert a.post("/api/post-media", content=b"GIF89a" + b"junk" * 100).status_code == 400


def test_video_and_song_sniffing_and_ranges(client):
    a, b, c = trio(client)
    video = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 2000
    v = a.post("/api/post-media", content=video).json()
    assert v["kind"] == "video" and v["mime"] == "video/mp4"
    song = b"ID3" + b"\x03\x00" + b"\x00" * 300
    s = a.post("/api/post-media", content=song).json()
    assert s["kind"] == "audio"
    p = post(a, "", media=[v["id"], s["id"]])
    assert p.status_code == 200
    part = b.get(v["url"], headers={"Range": "bytes=4-7"})
    assert part.status_code == 206 and part.content == b"ftyp"
    # an m4a song says M4A, so it isn't taken for a video
    m4a = a.post("/api/post-media", content=b"\x00\x00\x00\x18ftypM4A " + b"\x00" * 300).json()
    assert m4a["kind"] == "audio"


def test_media_mix_rules(client):
    a, b, c = trio(client)
    video = b"\x00\x00\x00\x18ftypisom" + b"\x00" * 2000
    v = a.post("/api/post-media", content=video).json()
    i = png(a)
    assert post(a, "", media=[v["id"], i["id"]]).status_code == 400
    five = [png(a)["id"] for _ in range(5)]
    assert post(a, "", media=five).status_code == 400
    assert post(a, "", media=[99999]).status_code == 400


def test_edit_swaps_media_and_removes_the_old(client):
    a, b, c = trio(client)
    one, two = png(a), png(a)
    pid = post(a, "x", media=[one["id"]]).json()["id"]
    e = a.patch(f"/api/posts/{pid}", json={"media": [two["id"]]}).json()
    assert [m["id"] for m in e["media"]] == [two["id"]] and e["edited"]
    assert a.get(one["url"]).status_code == 404


def test_draft_limit_and_delete(client):
    a, b, c = trio(client)
    m = png(a)
    assert a.delete(f"/api/post-media/{m['id']}").status_code == 200
    assert a.delete(f"/api/post-media/{m['id']}").status_code == 404


# ---------- the picture check ----------

def test_picture_check_off_by_default_and_fails_closed(client, monkeypatch):
    a, b, c = trio(client)
    assert moderation.check_image(make_image("PNG").getvalue() if hasattr(make_image("PNG"), "getvalue") else make_image("PNG")) is None
    monkeypatch.setenv("CIPHER_IMAGE_CHECK", "nudenet")
    monkeypatch.setattr(moderation, "_nudenet_flags", lambda png: (_ for _ in ()).throw(ImportError()))
    assert a.post("/api/post-media", content=make_image("PNG").getvalue() if hasattr(make_image("PNG"), "getvalue") else make_image("PNG")).status_code == 400
    monkeypatch.setattr(moderation, "_nudenet_flags", lambda png: True)
    r = a.post("/api/post-media", content=make_image("PNG").getvalue() if hasattr(make_image("PNG"), "getvalue") else make_image("PNG"))
    assert r.status_code == 400 and "picture" in r.json()["detail"]
    monkeypatch.setattr(moderation, "_nudenet_flags", lambda png: False)
    assert a.post("/api/post-media", content=make_image("PNG").getvalue() if hasattr(make_image("PNG"), "getvalue") else make_image("PNG")).status_code == 200


# ---------- likes ----------

def test_liked_by_names_and_privacy_levels(client):
    a, b, c = trio(client)
    pid = post(a, "x").json()["id"]
    b.post(f"/api/posts/{pid}/like"); a.post(f"/api/posts/{pid}/like")
    seen = b.get(f"/api/posts/{pid}").json()
    assert seen["likes"] == 2 and {p["username"] for p in seen["likers"]} == {"alice", "bob"}
    names = b.get(f"/api/posts/{pid}/likes").json()
    assert names["count"] == 2
    a.put("/api/settings", json={"likes_visibility": "count"})
    seen = b.get(f"/api/posts/{pid}").json()
    assert seen["likes"] == 2 and seen["likers"] == [] and not seen["likes_names"]
    assert b.get(f"/api/posts/{pid}/likes").status_code == 403
    assert a.get(f"/api/posts/{pid}/likes").json()["count"] == 2  # the author still sees them
    a.put("/api/settings", json={"likes_visibility": "private"})
    seen = b.get(f"/api/posts/{pid}").json()
    assert seen["likes"] is None and seen["likes_hidden"] and seen["liked"] is True
    assert a.get(f"/api/posts/{pid}").json()["likes"] == 2


def test_blocked_people_are_left_out_of_liked_by(client):
    a, b, c = trio(client)
    pid = post(a, "x").json()["id"]
    b.post(f"/api/posts/{pid}/like")
    c.post(f"/api/posts/{pid}/like")
    c.post("/api/blocks/bob")  # carol blocks bob, so carol doesn't see him, alice still does
    assert {p["username"] for p in c.get(f"/api/posts/{pid}/likes").json()["likers"]} == {"carol"}
    assert {p["username"] for p in a.get(f"/api/posts/{pid}/likes").json()["likers"]} == {"bob", "carol"}


# ---------- repost and chat share rules ----------

def test_only_open_posts_can_be_reposted_or_sent(client):
    a, b, c = trio(client)
    close = post(a, "x", audience="close").json()
    assert close["can_repost"] is False and close["can_send"] is False
    open_ = post(a, "y").json()
    assert open_["can_repost"] and open_["can_send"]
    a.put("/api/close-friends", json={"usernames": ["bob"]})
    assert b.post(f"/api/posts/{close['id']}/repost", json={}).status_code == 403
    assert b.post(f"/api/posts/{open_['id']}/repost", json={}).status_code == 200


def test_author_can_switch_reposts_and_sending_off(client):
    a, b, c = trio(client)
    a.put("/api/settings", json={"allow_reposts": False, "allow_chat_shares": False})
    p = post(a, "x").json()
    seen = b.get(f"/api/posts/{p['id']}").json()
    assert seen["can_repost"] is False and seen["can_send"] is False
    assert b.post(f"/api/posts/{p['id']}/repost", json={}).status_code == 403


def test_repost_note_is_checked_and_original_audience_change_hides_it(client):
    a, b, c = trio(client)
    pid = post(a, "orig").json()["id"]
    assert b.post(f"/api/posts/{pid}/repost", json={"body": "kys"}).status_code == 400
    rp = b.post(f"/api/posts/{pid}/repost", json={"body": "nice"}).json()
    a.patch(f"/api/posts/{pid}", json={"audience": "me"})
    again = b.get(f"/api/posts/{rp['id']}").json()
    assert again["original"] == {"hidden": True}


# ---------- reports ----------

