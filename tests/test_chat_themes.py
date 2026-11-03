from tests.test_groups import make_user, new_group, trio
from tests.test_backend import ORIGIN, client, signup  # noqa: F401

DEFAULT = {"theme": "classic", "accent": "", "pattern": "none"}


def test_starts_empty(client):
    a = signup(client, "alice")
    assert a.get("/api/chat-themes").json() == {"dm": {}, "group": {}}
