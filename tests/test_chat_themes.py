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
