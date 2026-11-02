import base64

from tests.test_backend import ORIGIN, client, signup  # noqa: F401


def pub(ch: str) -> str:
    return base64.b64encode(b"\x04" + ch.encode() * 64).decode()


def wrap(user: str) -> dict:
    # the server can't tell a real wrapped key from random bytes, only that the sizes are right
    return {
        "user": user,
        "iv": base64.b64encode(b"i" * 12).decode(),
        "wk": base64.b64encode(b"k" * 48).decode(),
    }


def wraps(*users):
    return [wrap(u) for u in users]


def make_user(client, name, ch):
    c = signup(client, name)
    assert c.put("/api/key", json={"pub": pub(ch)}).status_code == 200
    return c


def befriend(a, a_name, b, b_name):
    a.post(f"/api/friends/{b_name}")
    assert b.post(f"/api/friends/{a_name}/accept").status_code == 200


def trio(client):
    """alice is friends with bob and carol; bob and carol don't know each other."""
    a = make_user(client, "alice", "a")
    b = make_user(client, "bob", "b")
    c = make_user(client, "carol", "c")
    befriend(a, "alice", b, "bob")
    befriend(a, "alice", c, "carol")
    return a, b, c


def new_group(a, members=("bob", "carol"), name="the gang"):
    r = a.post(
        "/api/groups",
        json={"name": name, "members": list(members), "keys": wraps("alice", *members)},
    )
    assert r.status_code == 200, r.text
    return r.json()


def drain(ws):
    """Everything the socket has for us, up to a ping we send ourselves."""
    ws.send_json({"type": "ping"})
    out = []
    while True:
        frame = ws.receive_json()
        if frame["type"] == "pong":
            return out
        out.append(frame)


def of_type(frames, kind):
    return [f for f in frames if f["type"] == kind]


def test_create_group_stores_only_wrapped_keys(client):
    a, b, c = trio(client)
    g = new_group(a)
    assert g["name"] == "the gang" and g["owner"] == "alice" and g["key_version"] == 1
    assert {m["username"] for m in g["members"]} == {"alice", "bob", "carol"}
    # each member can fetch their own wrapped key and nobody else's
    mine = g["keys"]
    assert len(mine) == 1 and mine[0]["version"] == 1 and mine[0]["from"] == "alice"
    assert mine[0]["from_pub"] == pub("a")
    assert len(b.get(f"/api/groups/{g['id']}").json()["keys"]) == 1
    listed = b.get("/api/groups").json()
    assert listed[0]["id"] == g["id"] and listed[0]["members"] == 3


def test_create_group_validation(client):
    a, b, c = trio(client)
    d = make_user(client, "dave", "d")  # not alice's friend
    body = lambda members, keys, name="x": {"name": name, "members": members, "keys": keys}  # noqa: E731

    assert a.post("/api/groups", json=body([], wraps("alice"))).status_code == 400
    assert a.post("/api/groups", json=body(["bob"], wraps("alice", "bob"), name="  ")).status_code == 400
    # not a friend
    assert a.post("/api/groups", json=body(["dave"], wraps("alice", "dave"))).status_code == 400
    # unknown user
    assert a.post("/api/groups", json=body(["ghost"], wraps("alice", "ghost"))).status_code == 404
    # keys must be for exactly the members
    assert a.post("/api/groups", json=body(["bob"], wraps("alice"))).status_code == 400
    assert a.post("/api/groups", json=body(["bob"], wraps("alice", "bob", "carol"))).status_code == 400
    assert a.post("/api/groups", json=body(["bob"], wraps("alice", "alice"))).status_code == 400
    # a wrapped key has to be the right size
    bad = wraps("alice", "bob")
    bad[1]["wk"] = base64.b64encode(b"short").decode()
    assert a.post("/api/groups", json=body(["bob"], bad)).status_code == 400
    # blocked either way
    b.post("/api/blocks/alice")
    assert a.post("/api/groups", json=body(["bob"], wraps("alice", "bob"))).status_code == 400


def test_non_members_cannot_see_a_group(client):
    a, b, c = trio(client)
    d = make_user(client, "dave", "d")
    g = new_group(a, members=("bob",))
    gid = g["id"]
    assert c.get(f"/api/groups/{gid}").status_code == 404
    assert c.get(f"/api/groups/{gid}/messages").status_code == 404
    assert c.put(f"/api/groups/{gid}", json={"name": "mine now"}).status_code == 404
    assert d.get("/api/groups").json() == []


def test_group_message_flow_and_history(client):
    a, b, c = trio(client)
    gid = new_group(a)["id"]
    with a.websocket_connect("/ws", headers=ORIGIN) as wa, b.websocket_connect("/ws", headers=ORIGIN) as wb:
        drain(wa), drain(wb)
        wa.send_json({"type": "gtyping", "group": gid, "state": True})
        assert of_type(drain(wb), "gtyping") == [{"type": "gtyping", "group": gid, "from": "alice", "state": True}]

        wa.send_json({"type": "gmsg", "group": gid, "v": 1, "iv": "aXY=", "ct": "Y3Q=", "cid": "c1"})
        got = of_type(drain(wb), "gmsg")
        assert len(got) == 1 and got[0]["from"] == "alice" and got[0]["cid"] == "c1" and got[0]["v"] == 1
        echo = of_type(drain(wa), "gmsg")
        assert echo[0]["id"] == got[0]["id"]

        # carol is offline: she finds it in her history, and as unread
        assert c.get("/api/groups").json()[0]["unread"] == 1
        assert [m["from"] for m in c.get(f"/api/groups/{gid}/messages").json()] == ["alice"]

        # bob reads it, alice finds out, bob's unread goes to zero
        wb.send_json({"type": "gread", "group": gid})
        seen = of_type(drain(wa), "gseen")
        assert seen == [{"type": "gseen", "group": gid, "by": "bob", "upto": got[0]["id"]}]
        assert of_type(drain(wb), "gread-sync")
    assert b.get("/api/groups").json()[0]["unread"] == 0
    hist = a.get(f"/api/groups/{gid}/messages").json()
    assert hist[0]["seen_by"] == ["bob"]
    # the person who wrote it never has their own message as unread
    assert a.get("/api/groups").json()[0]["unread"] == 0


def test_cannot_post_without_the_key_or_membership(client):
    a, b, c = trio(client)
    d = make_user(client, "dave", "d")
    gid = new_group(a, members=("bob",))["id"]
    with d.websocket_connect("/ws", headers=ORIGIN) as wd, a.websocket_connect("/ws", headers=ORIGIN) as wa:
        drain(wd), drain(wa)
        wd.send_json({"type": "gmsg", "group": gid, "v": 1, "iv": "aXY=", "ct": "Y3Q="})
        assert of_type(drain(wd), "gmsg-rejected")[0]["reason"] == "not_member"
        # a key version that doesn't exist yet
        wa.send_json({"type": "gmsg", "group": gid, "v": 2, "iv": "aXY=", "ct": "Y3Q="})
        assert of_type(drain(wa), "gmsg-rejected")[0]["reason"] == "bad_key"
        wa.send_json({"type": "gmsg", "group": "1", "v": 1, "iv": "aXY=", "ct": "Y3Q="})
        wa.send_json({"type": "gmsg", "group": gid, "v": 1, "iv": "aXY=", "ct": ""})
        assert drain(wa) == []
    assert a.get(f"/api/groups/{gid}/messages").json() == []


def test_new_member_gets_a_new_key_and_cannot_read_the_past(client):
    a, b, c = trio(client)
    gid = new_group(a, members=("bob",))["id"]
    with a.websocket_connect("/ws", headers=ORIGIN) as wa:
        drain(wa)
        wa.send_json({"type": "gmsg", "group": gid, "v": 1, "iv": "aXY=", "ct": "Y3Q="})
        drain(wa)

    # wrong version: the key has to move to 2
    r = a.post(f"/api/groups/{gid}/members", json={"username": "carol", "version": 1, "keys": wraps("alice", "bob", "carol")})
    assert r.status_code == 409
    # keys for the wrong set of people
    r = a.post(f"/api/groups/{gid}/members", json={"username": "carol", "version": 2, "keys": wraps("alice", "carol")})
    assert r.status_code == 400
    r = a.post(f"/api/groups/{gid}/members", json={"username": "carol", "version": 2, "keys": wraps("alice", "bob", "carol")})
    assert r.status_code == 200 and r.json()["key_version"] == 2 and r.json()["members"][-1]["username"] == "carol"
