from tests.test_groups import make_user, new_group, trio
from tests.test_backend import ORIGIN, client, signup  # noqa: F401

DEFAULT = {"theme": "classic", "accent": "", "pattern": "none"}


def test_starts_empty(client):
    a = signup(client, "alice")
    assert a.get("/api/chat-themes").json() == {"dm": {}, "group": {}}


def test_needs_login(client):
    assert client.get("/api/chat-themes").status_code == 401
    assert client.put("/api/chat-themes/dm/bob", json=DEFAULT).status_code == 401


def test_set_and_read_dm_theme(client):
    a = signup(client, "alice")
    signup(client, "bob")
    look = {"theme": "gothic", "accent": "#B3122A", "pattern": "hearts"}
    r = a.put("/api/chat-themes/dm/bob", json=look)
    assert r.status_code == 200
    assert r.json() == {"theme": "gothic", "accent": "#b3122a", "pattern": "hearts"}
    assert a.get("/api/chat-themes").json()["dm"] == {"bob": r.json()}


def test_theme_is_private_to_you(client):
    a = make_user(client, "alice", "a")
    b = make_user(client, "bob", "b")
    a.put("/api/chat-themes/dm/bob", json={"theme": "neon", "accent": "", "pattern": "grid"})
    assert b.get("/api/chat-themes").json() == {"dm": {}, "group": {}}


def test_back_to_default_forgets_it(client):
    a = signup(client, "alice")
    signup(client, "bob")
    a.put("/api/chat-themes/dm/bob", json={"theme": "emo", "accent": "", "pattern": "none"})
    assert a.put("/api/chat-themes/dm/bob", json=DEFAULT).json() == DEFAULT
    assert a.get("/api/chat-themes").json()["dm"] == {}


def test_changing_it_again_replaces_it(client):
    a = signup(client, "alice")
    signup(client, "bob")
    a.put("/api/chat-themes/dm/bob", json={"theme": "emo", "accent": "", "pattern": "none"})
    a.put("/api/chat-themes/dm/bob", json={"theme": "ocean", "accent": "#112233", "pattern": "dots"})
    assert a.get("/api/chat-themes").json()["dm"]["bob"]["theme"] == "ocean"


def test_rejects_bad_values(client):
    a = signup(client, "alice")
    signup(client, "bob")
    bad = [
        {"theme": "<script>", "accent": "", "pattern": "none"},
        {"theme": "classic", "accent": "red", "pattern": "none"},
        {"theme": "classic", "accent": "url(x)", "pattern": "none"},
        {"theme": "classic", "accent": "", "pattern": "svg"},
    ]
    for body in bad:
        assert a.put("/api/chat-themes/dm/bob", json=body).status_code == 400, body
    assert a.get("/api/chat-themes").json()["dm"] == {}


def test_unknown_user_and_self(client):
    a = signup(client, "alice")
    assert a.put("/api/chat-themes/dm/nobody", json=DEFAULT).status_code == 404
    assert a.put("/api/chat-themes/dm/alice", json=DEFAULT).status_code == 400


def test_group_theme_for_members_only(client):
    a, b, c = trio(client)
    d = make_user(client, "dave", "d")
    gid = new_group(a, members=("bob",))["id"]
    look = {"theme": "kawaii", "accent": "#ff6fb5", "pattern": "stars"}
    assert a.put(f"/api/chat-themes/group/{gid}", json=look).status_code == 200
    assert a.get("/api/chat-themes").json()["group"] == {str(gid): look}
    assert b.get("/api/chat-themes").json()["group"] == {}
    assert c.put(f"/api/chat-themes/group/{gid}", json=look).status_code == 404
    assert d.put(f"/api/chat-themes/group/{gid}", json=look).status_code == 404
    assert d.put("/api/chat-themes/group/9999", json=look).status_code == 404


def test_leaving_a_group_drops_its_theme(client):
    from backend import db

    a, b, _ = trio(client)
    gid = new_group(a, members=("bob",))["id"]
    b.put(f"/api/chat-themes/group/{gid}", json={"theme": "forest", "accent": "", "pattern": "dots"})
    assert b.delete(f"/api/groups/{gid}/members/bob").status_code == 200
    assert b.get("/api/chat-themes").json()["group"] == {}
    conn = db.connect()
    try:
        left = conn.execute("SELECT COUNT(*) FROM chat_themes WHERE kind = 'group'").fetchone()[0]
    finally:
        conn.close()
    assert left == 0
