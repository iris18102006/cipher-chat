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


