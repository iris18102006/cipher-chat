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
