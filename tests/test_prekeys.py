import base64

import pytest

from backend import main
from tests.test_backend import ORIGIN, client, signup  # noqa: F401


@pytest.fixture(autouse=True)
def fresh_claims():
    main._claims.clear()


def pk(ch: str) -> str:
    # the server can't tell a real public key from random bytes, only that the shape is right
    return base64.b64encode(b"\x04" + ch.encode() * 64).decode()


def batch(start: int, n: int) -> dict:
    return {"keys": [{"id": i, "pub": pk(chr(97 + i % 26))} for i in range(start, start + n)]}


def make_user(client, name, ch):
    c = signup(client, name)
    assert c.put("/api/key", json={"pub": pk(ch)}).status_code == 200
    return c


def befriend(a, b, an, bn):
    a.post(f"/api/friends/{bn}")
    b.post(f"/api/friends/{an}/accept")


def test_prekey_upload_and_count(client):
    a = make_user(client, "alice", "a")
    assert a.get("/api/prekeys").json() == {"count": 0}
    r = a.put("/api/prekeys", json=batch(1, 5))
    assert r.status_code == 200 and r.json() == {"count": 5}
    assert a.get("/api/prekeys").json() == {"count": 5}
    # sending a key id that's already stored replaces it instead of adding another
    assert a.put("/api/prekeys", json=batch(5, 2)).json() == {"count": 6}


def test_prekey_upload_needs_login(client):
    assert client.put("/api/prekeys", json=batch(1, 1)).status_code == 401
    assert client.post("/api/prekeys/claim/alice").status_code == 401


def test_prekey_upload_validation(client):
    a = make_user(client, "alice", "a")
    assert a.put("/api/prekeys", json={"keys": []}).status_code == 400
    assert a.put("/api/prekeys", json=batch(1, 101)).status_code == 400
    dup = {"keys": [{"id": 1, "pub": pk("a")}, {"id": 1, "pub": pk("b")}]}
    assert a.put("/api/prekeys", json=dup).status_code == 400
    assert a.put("/api/prekeys", json={"keys": [{"id": 0, "pub": pk("a")}]}).status_code == 400
    assert a.put("/api/prekeys", json={"keys": [{"id": -4, "pub": pk("a")}]}).status_code == 400
    assert a.put("/api/prekeys", json={"keys": [{"id": 3_000_000_000, "pub": pk("a")}]}).status_code == 400
    assert a.put("/api/prekeys", json={"keys": [{"id": 1, "pub": "nope"}]}).status_code == 400
    # nothing from a rejected batch is kept, not even the good keys in it
    bad_mix = {"keys": [{"id": 1, "pub": pk("a")}, {"id": 2, "pub": "nope"}]}
    assert a.put("/api/prekeys", json=bad_mix).status_code == 400
    assert a.get("/api/prekeys").json() == {"count": 0}


def test_prekey_storage_cap(client):
    a = make_user(client, "alice", "a")
    assert a.put("/api/prekeys", json=batch(1, 100)).status_code == 200
    assert a.put("/api/prekeys", json=batch(101, 100)).status_code == 200
    assert a.put("/api/prekeys", json=batch(201, 1)).status_code == 400
    # replacing keys that are already there doesn't count towards the cap
    assert a.put("/api/prekeys", json=batch(1, 10)).status_code == 200
    assert a.get("/api/prekeys").json() == {"count": 200}


def test_each_prekey_is_handed_out_once(client):
    a, b = make_user(client, "alice", "a"), make_user(client, "bob", "b")
    befriend(a, b, "alice", "bob")
    a.put("/api/prekeys", json=batch(1, 3))
    got = [b.post("/api/prekeys/claim/alice").json() for _ in range(3)]
    assert [g["id"] for g in got] == [1, 2, 3]
    assert got[0]["pub"] == pk("b")
    # all gone: the sender is told so, instead of being handed a used key again
    assert b.post("/api/prekeys/claim/alice").json() == {"none": True}
    assert a.get("/api/prekeys").json() == {"count": 0}


def test_claim_is_refused_when_you_couldnt_message_them_anyway(client):
    a, b = make_user(client, "alice", "a"), make_user(client, "bob", "b")
    a.put("/api/prekeys", json=batch(1, 3))
    # strangers can't message each other, so they can't use up each other's keys
    assert b.post("/api/prekeys/claim/alice").json() == {"refused": "not_friends"}
    assert a.get("/api/prekeys").json() == {"count": 3}
    assert b.post("/api/prekeys/claim/nobody_here").status_code == 404
    assert b.post("/api/prekeys/claim/bob").status_code == 400
