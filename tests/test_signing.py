import base64

from backend import db
from tests.test_backend import ORIGIN
from tests.test_groups import drain, gm, new_group, of_type, pub, trio


def sig(ch: str = "s") -> str:
    # a real ECDSA P-256 signature is 64 bytes (r and s), the server only checks the size
    return base64.b64encode(ch.encode() * 64).decode()


def test_signing_key_upload(client):
    a, b, c = trio(client)
    assert a.put("/api/signkey", json={"pub": pub("x")}).status_code == 200
    assert a.put("/api/signkey", json={"pub": "nope"}).status_code == 400
    # the key an identity uses for ECDH is not accepted if it's the wrong shape
    assert a.put("/api/signkey", json={"pub": pub("x")[:-4]}).status_code == 400


def test_signing_key_needs_login(client):
    assert client.put("/api/signkey", json={"pub": pub("x")}).status_code == 401


def test_members_see_each_others_signing_keys(client):
    a, b, c = trio(client)
    b.put("/api/signkey", json={"pub": pub("y")})
    g = new_group(a)
    by_name = {m["username"]: m for m in g["members"]}
    assert by_name["bob"]["sign_pub"] == pub("y")
    # carol never uploaded one, that's null and not a missing field
    assert by_name["carol"]["sign_pub"] is None
    assert by_name["alice"]["sign_pub"] is None


def test_signature_travels_with_the_message_and_stays_in_history(client):
    a, b, c = trio(client)
    gid = new_group(a)["id"]
    s = sig("a")
    with a.websocket_connect("/ws", headers=ORIGIN) as wa, b.websocket_connect("/ws", headers=ORIGIN) as wb:
        drain(wa), drain(wb)
        wa.send_json(gm(gid, 1, cid="c1", sig=s))
        got = of_type(drain(wb), "gmsg")
        assert got[0]["sig"] == s
        assert of_type(drain(wa), "gmsg")[0]["sig"] == s
    assert b.get(f"/api/groups/{gid}/messages").json()[0]["sig"] == s


def test_new_messages_must_be_signed(client):
    a, b, c = trio(client)
    gid = new_group(a)["id"]
    with a.websocket_connect("/ws", headers=ORIGIN) as wa:
        drain(wa)
        wa.send_json(gm(gid, 1, cid="c1", sig=None))
        frames = drain(wa)
        assert of_type(frames, "gmsg-rejected")[0]["reason"] == "bad_n"
        assert not of_type(frames, "gmsg")
    assert a.get(f"/api/groups/{gid}/messages").json() == []


def test_old_key_versions_can_still_be_sent_to_without_numbers_or_signatures(client):
    # a group from before forward secrecy: its key version 1 is "legacy", numbers start at 2
    a, b, c = trio(client)
    gid = new_group(a)["id"]
    with db.connect() as conn:
        conn.execute("UPDATE chat_groups SET fs_version = 2 WHERE id = ?", (gid,))
    with a.websocket_connect("/ws", headers=ORIGIN) as wa:
        drain(wa)
        legacy = gm(gid, 1, cid="c1", sig=None)
        del legacy["n"]
        wa.send_json(legacy)
        assert of_type(drain(wa), "gmsg")[0]["n"] is None
        # but a number on a legacy version means something is wrong
        wa.send_json(gm(gid, 1, cid="c2"))
        assert of_type(drain(wa), "gmsg-rejected")[0]["reason"] == "bad_n"


def test_badly_shaped_signatures_are_rejected(client):
    a, b, c = trio(client)
    gid = new_group(a)["id"]
    with a.websocket_connect("/ws", headers=ORIGIN) as wa:
        drain(wa)
        for bad in ("short", "!!!notbase64!!!", 12, base64.b64encode(b"x" * 63).decode(), base64.b64encode(b"x" * 65).decode()):
            wa.send_json(gm(gid, 1, cid="c1", sig=bad))
            frames = drain(wa)
            assert of_type(frames, "gmsg-rejected")[0]["reason"] == "bad_sig"
            assert not of_type(frames, "gmsg")
    assert a.get(f"/api/groups/{gid}/messages").json() == []
