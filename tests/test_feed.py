import pytest

from backend import main
from tests.test_backend import ORIGIN
from tests.test_groups import drain, of_type, trio


@pytest.fixture(autouse=True)
def fresh_rate_limit():
    # the limiter lives in memory and every test starts with user id 1 again
    main.feed._recent.clear()


def post(c, text="hello world"):
    return c.post("/api/posts", json={"body": text})


def ids(c, **q):
    return [p["id"] for p in c.get("/api/feed", params=q).json()["posts"]]


def test_needs_login(client):
    assert client.get("/api/feed").status_code == 401
    assert client.post("/api/posts", json={"body": "x"}).status_code == 401


def test_write_and_read_own_post(client):
    a, b, c = trio(client)
    r = post(a, "my first post")
    assert r.status_code == 200
    p = r.json()
    assert p["body"] == "my first post" and p["mine"] and p["likes"] == 0 and not p["is_share"]
    assert ids(a) == [p["id"]]


def test_posts_are_text_and_validated(client):
    a, b, c = trio(client)
    assert post(a, "   ").status_code == 400
    assert post(a, "x" * 501).status_code == 400
    assert post(a, "x" * 500).status_code == 200
    # html is kept as plain text, the browser shows it with textContent
    assert post(a, "<b>hi</b>").json()["body"] == "<b>hi</b>"


def test_friends_see_it_strangers_dont(client):
    a, b, c = trio(client)  # bob and carol are not friends with each other
    pid = post(b, "bob's post").json()["id"]
    assert pid in ids(a) and pid in ids(b)
    assert ids(c) == []


def test_newest_first_and_paging(client):
    a, b, c = trio(client)
    made = [post(a, f"p{i}").json()["id"] for i in range(5)]
    first = a.get("/api/feed", params={"limit": 2}).json()
    assert [p["id"] for p in first["posts"]] == made[::-1][:2] and first["more"] is True
    second = a.get("/api/feed", params={"limit": 2, "before": first["posts"][-1]["id"]}).json()
    assert [p["id"] for p in second["posts"]] == made[::-1][2:4] and second["more"] is True
    last = a.get("/api/feed", params={"limit": 2, "before": second["posts"][-1]["id"]}).json()
    assert [p["id"] for p in last["posts"]] == made[:1] and last["more"] is False
    assert a.get("/api/feed", params={"limit": 0}).status_code == 422


def test_blocking_hides_posts_both_ways(client):
    a, b, c = trio(client)
    pid = post(b).json()["id"]
    assert pid in ids(a)
    assert a.post("/api/blocks/bob").status_code == 200
    assert pid not in ids(a)
    mine = post(a).json()["id"]
    assert mine not in ids(b)


def test_delete_only_your_own(client):
    a, b, c = trio(client)
    pid = post(b).json()["id"]
    assert a.delete(f"/api/posts/{pid}").status_code == 404
    assert pid in ids(b)
    assert b.delete(f"/api/posts/{pid}").status_code == 200
    assert ids(a) == [] and b.delete(f"/api/posts/{pid}").status_code == 404


def test_like_and_unlike(client):
    a, b, c = trio(client)
    pid = post(b).json()["id"]
    assert a.post(f"/api/posts/{pid}/like").json() == {"likes": 1, "liked": True}
    assert a.post(f"/api/posts/{pid}/like").json() == {"likes": 1, "liked": True}  # twice is still one
    assert b.post(f"/api/posts/{pid}/like").json()["likes"] == 2
    seen = [p for p in a.get("/api/feed").json()["posts"] if p["id"] == pid][0]
    assert seen["likes"] == 2 and seen["liked"] is True
    assert a.delete(f"/api/posts/{pid}/like").json() == {"likes": 1, "liked": False}


def test_cannot_like_what_you_cannot_see(client):
    a, b, c = trio(client)
    pid = post(b).json()["id"]
    assert c.post(f"/api/posts/{pid}/like").status_code == 404
    assert a.post("/api/posts/99999/like").status_code == 404


def test_share_with_a_note(client):
    a, b, c = trio(client)
    pid = post(b, "original").json()["id"]
    r = a.post(f"/api/posts/{pid}/share", json={"body": "look at this"})
    assert r.status_code == 200
    s = r.json()
    assert s["is_share"] and s["body"] == "look at this" and s["original"]["body"] == "original"
    assert s["original"]["shares"] == 1
    assert a.post(f"/api/posts/{pid}/share", json={"body": ""}).status_code == 409


def test_share_without_a_note_is_fine(client):
    a, b, c = trio(client)
    pid = post(b, "original").json()["id"]
    r = a.post(f"/api/posts/{pid}/share", json={})
    assert r.status_code == 200 and r.json()["body"] == ""


def test_sharing_does_not_leak_the_original(client):
    a, b, c = trio(client)
    pid = post(b, "for bob's friends only").json()["id"]
    sid = a.post(f"/api/posts/{pid}/share", json={"body": "wow"}).json()["id"]
    # carol is alice's friend, not bob's: she sees alice's share, but not what it says
    seen = [p for p in c.get("/api/feed").json()["posts"] if p["id"] == sid][0]
    assert seen["original"] == {"hidden": True}
    assert "for bob's friends only" not in str(c.get("/api/feed").json())
    # and she can't share the original herself, or find it any other way
    assert c.post(f"/api/posts/{pid}/share", json={}).status_code == 404


def test_sharing_a_share_shares_the_original(client):
    a, b, c = trio(client)
    pid = post(a, "root").json()["id"]
    sid = b.post(f"/api/posts/{pid}/share", json={"body": "b"}).json()["id"]
    # alice can see bob's share; sharing it points at the root post, not at the share
    again = c.post(f"/api/posts/{sid}/share", json={"body": "c"})
    assert again.status_code == 404  # carol isn't bob's friend, so it isn't hers to share
    # alice can: it points at the root post, never at bob's share
    ok = a.post(f"/api/posts/{sid}/share", json={"body": "a"})
    assert ok.status_code == 200 and ok.json()["original"]["id"] == pid
    assert a.post(f"/api/posts/{sid}/share", json={}).status_code == 409  # already shared that root
    d = c.post(f"/api/posts/{pid}/share", json={"body": "c"})
    assert d.status_code == 200 and d.json()["original"]["id"] == pid


def test_deleting_the_original_leaves_the_share_saying_so(client):
    a, b, c = trio(client)
    pid = post(b, "gone soon").json()["id"]
    sid = a.post(f"/api/posts/{pid}/share", json={"body": "so true"}).json()["id"]
    assert b.delete(f"/api/posts/{pid}").status_code == 200
    s = [p for p in a.get("/api/feed").json()["posts"] if p["id"] == sid][0]
    assert s["is_share"] and s["body"] == "so true" and s["original"] == {"gone": True}
    # sharing that dead share isn't possible
    assert b.post(f"/api/posts/{sid}/share", json={}).status_code == 404


def test_rate_limit(client, monkeypatch):
    monkeypatch.setattr("backend.feed.POSTS_PER_WINDOW", 3)
    a, b, c = trio(client)
    assert [post(a).status_code for _ in range(4)] == [200, 200, 200, 429]


def test_friends_online_get_a_nudge(client):
    a, b, c = trio(client)
    with b.websocket_connect("/ws", headers=ORIGIN) as wb, c.websocket_connect("/ws", headers=ORIGIN) as wc:
        drain(wb), drain(wc)
        pid = post(a, "ping").json()["id"]
        got = of_type(drain(wb), "feed")
        assert got and got[0]["id"] == pid and got[0]["from"] == "alice"
        assert of_type(drain(wc), "feed")  # carol is alice's friend too
