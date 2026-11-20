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


