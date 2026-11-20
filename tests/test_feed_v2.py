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


