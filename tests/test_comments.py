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


def test_comments_are_counted_on_the_post_and_the_feed(client):
    a, b, c = trio(client)
    pid = post(a)
    assert a.get(f"/api/posts/{pid}").json()["comments"] == 0
    say(b, pid, "one")
    say(c, pid, "two")
    assert a.get(f"/api/posts/{pid}").json()["comments"] == 2
    feed = a.get("/api/feed").json()["posts"]
    assert [p["comments"] for p in feed if p["id"] == pid] == [2]


def test_oldest_comment_first_and_paging_goes_back_in_time(client):
    a, b, _ = trio(client)
    pid = post(a)
    for n in range(5):
        say(b, pid, f"c{n}")
    page = b.get(f"/api/posts/{pid}/comments", params={"limit": 2}).json()
    assert [x["body"] for x in page["comments"]] == ["c3", "c4"] and page["more"] is True
    older = b.get(f"/api/posts/{pid}/comments", params={"limit": 2, "before": page["comments"][0]["id"]}).json()
    assert [x["body"] for x in older["comments"]] == ["c1", "c2"] and older["more"] is True
    last = b.get(f"/api/posts/{pid}/comments", params={"limit": 2, "before": older["comments"][0]["id"]}).json()
    assert [x["body"] for x in last["comments"]] == ["c0"] and last["more"] is False


def test_you_cant_comment_on_posts_you_cant_see(client):
    a, b, c = trio(client)
    private = post(a, "diary", audience="me")
    close = post(a, "close", audience="close")
    assert say(b, private).status_code == 404
    assert say(b, close).status_code == 404
    assert b.get(f"/api/posts/{private}/comments").status_code == 404
    # the author can always comment on their own
    assert say(a, private, "note to self").status_code == 200
