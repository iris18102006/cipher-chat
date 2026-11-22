"""Comments under posts: who can write, edit and delete them, and who sees them."""
import pytest

from backend import main  # noqa: F401  (main has to be imported first, the other modules import it)
from backend import comments, db, media
from tests.test_groups import trio


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    main.feed._recent.clear()
    comments._recent.clear()
    media.upload_limiter.clear()
    monkeypatch.delenv("CIPHER_ADMINS", raising=False)


def post(c, text="hi", **extra):
    return c.post("/api/posts", json={"body": text, **extra}).json()["id"]


def say(c, pid, text="nice"):
    return c.post(f"/api/posts/{pid}/comments", json={"body": text})


def texts(c, pid):
    return [x["body"] for x in c.get(f"/api/posts/{pid}/comments").json()["comments"]]


def test_a_friend_can_comment_and_everyone_who_sees_the_post_reads_it(client):
    a, b, c = trio(client)
    pid = post(a, "my post")
    r = say(b, pid, "love it")
    assert r.status_code == 200
    got = r.json()
    assert got["body"] == "love it" and got["author"]["username"] == "bob" and got["mine"] is True
    assert got["edited"] is False and got["can_delete"] is True
    assert texts(c, pid) == ["love it"]
    seen_by_carol = c.get(f"/api/posts/{pid}/comments").json()["comments"][0]
    assert seen_by_carol["mine"] is False and seen_by_carol["can_delete"] is False
