"""Comments under posts: who can write, edit and delete them, and who sees them."""
import pytest

from backend import main  # noqa: F401  (main has to be imported first, the other modules import it)
from backend import comments, db, media
from tests.test_groups import trio


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    main.feed._recent.clear()
    comments.comment_limiter.clear()
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


def test_empty_long_and_rude_comments_are_turned_away(client, monkeypatch):
    a, b, _ = trio(client)
    pid = post(a)
    assert say(b, pid, "   ").status_code == 400
    assert say(b, pid, "x" * 301).status_code == 400
    monkeypatch.setattr(main.moderation, "check_text", lambda t: "that isn't allowed" if "badword" in t else None)
    r = say(b, pid, "badword here")
    assert r.status_code == 400 and "isn't allowed" in r.json()["detail"]
    assert texts(a, pid) == []


def test_html_is_kept_as_plain_text(client):
    a, b, _ = trio(client)
    pid = post(a)
    say(b, pid, "<img src=x onerror=alert(1)>")
    assert texts(a, pid) == ["<img src=x onerror=alert(1)>"]


def test_only_the_writer_can_edit(client):
    a, b, c = trio(client)
    pid = post(a)
    cid = say(b, pid, "first").json()["id"]
    assert c.patch(f"/api/comments/{cid}", json={"body": "hacked"}).status_code == 403
    assert a.patch(f"/api/comments/{cid}", json={"body": "hacked"}).status_code == 403
    r = b.patch(f"/api/comments/{cid}", json={"body": "second"})
    assert r.status_code == 200 and r.json()["body"] == "second" and r.json()["edited"] is True
    assert texts(a, pid) == ["second"]
    assert b.patch(f"/api/comments/{cid}", json={"body": " "}).status_code == 400


def test_saving_the_same_words_is_not_an_edit(client):
    a, b, _ = trio(client)
    pid = post(a)
    cid = say(b, pid, "same").json()["id"]
    assert b.patch(f"/api/comments/{cid}", json={"body": "same"}).json()["edited"] is False


def test_writer_and_post_owner_can_delete_but_nobody_else(client):
    a, b, c = trio(client)
    pid = post(a)
    mine = say(b, pid, "bob's").json()["id"]
    other = say(c, pid, "carol's").json()["id"]
    assert c.delete(f"/api/comments/{mine}").status_code == 403  # not hers, not her post
    assert b.delete(f"/api/comments/{mine}").status_code == 200  # her own
    assert a.delete(f"/api/comments/{other}").status_code == 200  # under her post
    assert texts(a, pid) == []
    assert a.delete(f"/api/comments/{other}").status_code == 404


def test_deleting_the_post_takes_its_comments_along(client):
    a, b, _ = trio(client)
    pid = post(a)
    cid = say(b, pid).json()["id"]
    a.delete(f"/api/posts/{pid}")
    assert b.patch(f"/api/comments/{cid}", json={"body": "x"}).status_code == 404
    conn = db.connect()
    try:
        assert conn.execute("SELECT COUNT(*) FROM post_comments").fetchone()[0] == 0
    finally:
        conn.close()


def test_blocked_people_are_left_out(client):
    a, b, c = trio(client)
    pid = post(a)
    say(b, pid, "from bob")
    say(c, pid, "from carol")
    c.post("/api/blocks/bob")  # carol blocks bob
    assert texts(c, pid) == ["from carol"]
    assert c.get(f"/api/posts/{pid}").json()["comments"] == 1
    assert texts(a, pid) == ["from bob", "from carol"]


def test_a_block_with_the_author_hides_the_whole_thread(client):
    a, b, _ = trio(client)
    pid = post(a)
    say(b, pid, "hi")
    a.post("/api/blocks/bob")
    assert b.get(f"/api/posts/{pid}/comments").status_code == 404
    assert say(b, pid).status_code == 404


def test_comment_rate_limit(client, monkeypatch):
    a, b, _ = trio(client)
    pid = post(a)
    monkeypatch.setattr(comments, "COMMENTS_PER_WINDOW", 3)
    assert [say(b, pid, f"n{i}").status_code for i in range(4)] == [200, 200, 200, 429]


def test_you_must_be_logged_in(client):
    a, _, _ = trio(client)
    pid = post(a)
    client.cookies.clear()
    assert client.get(f"/api/posts/{pid}/comments").status_code in (401, 403)
