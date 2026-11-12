from backend import db
from tests.test_backend import ORIGIN
from tests.test_groups import drain, gm, make_user, new_group, of_type, trio


def send(ws, msg):
    ws.send_json(msg)
    return drain(ws)


def test_new_groups_are_forward_secret_from_version_1(client):
    a, b, c = trio(client)
    g = new_group(a)
    assert g["fs_version"] == 1
    assert g["senders"] == []


def test_message_numbers_come_back_in_history_and_live(client):
    a, b, c = trio(client)
    gid = new_group(a)["id"]
    with a.websocket_connect("/ws", headers=ORIGIN) as wa, b.websocket_connect("/ws", headers=ORIGIN) as wb:
        drain(wa), drain(wb)
        wa.send_json(gm(gid, 1, n=0))
        assert of_type(drain(wb), "gmsg")[0]["n"] == 0
        wa.send_json(gm(gid, 1, n=1))
        drain(wa)
    assert [m["n"] for m in b.get(f"/api/groups/{gid}/messages").json()] == [0, 1]


def test_a_number_can_only_be_used_once_per_sender(client):
    a, b, c = trio(client)
    gid = new_group(a)["id"]
    with a.websocket_connect("/ws", headers=ORIGIN) as wa:
        drain(wa)
        assert of_type(send(wa, gm(gid, 1, n=5)), "gmsg")
        frames = send(wa, gm(gid, 1, n=5, ct="b3RoZXI="))  # a replay with other text
        assert of_type(frames, "gmsg-rejected")[0]["reason"] == "bad_n"
        assert not of_type(frames, "gmsg")
    assert len(a.get(f"/api/groups/{gid}/messages").json()) == 1


def test_two_senders_can_use_the_same_number(client):
    a, b, c = trio(client)
    gid = new_group(a)["id"]
    with a.websocket_connect("/ws", headers=ORIGIN) as wa, b.websocket_connect("/ws", headers=ORIGIN) as wb:
        drain(wa), drain(wb)
        assert of_type(send(wa, gm(gid, 1, n=0)), "gmsg")
        assert of_type(send(wb, gm(gid, 1, n=0)), "gmsg")


def test_bad_numbers_are_refused(client):
    a, b, c = trio(client)
    gid = new_group(a)["id"]
    with a.websocket_connect("/ws", headers=ORIGIN) as wa:
        drain(wa)
        for bad in (-1, 2**31, 1.5, "3", True, [1], {"a": 1}):
            msg = gm(gid, 1)
            msg["n"] = bad
            frames = send(wa, msg)
            assert of_type(frames, "gmsg-rejected")[0]["reason"] == "bad_n", bad
        msg = gm(gid, 1)
        del msg["n"]
        assert of_type(send(wa, msg), "gmsg-rejected")[0]["reason"] == "bad_n"
    assert a.get(f"/api/groups/{gid}/messages").json() == []


def test_senders_lists_who_has_written_in_each_version(client):
    a, b, c = trio(client)
    gid = new_group(a)["id"]
    with a.websocket_connect("/ws", headers=ORIGIN) as wa, b.websocket_connect("/ws", headers=ORIGIN) as wb:
        drain(wa), drain(wb)
        send(wa, gm(gid, 1, n=0))
        send(wb, gm(gid, 1, n=0))
        send(wa, gm(gid, 1, n=1))
    assert a.get(f"/api/groups/{gid}").json()["senders"] == [{"v": 1, "u": "alice"}, {"v": 1, "u": "bob"}]


def test_ack_destroys_my_wrapped_key_and_only_mine(client):
    a, b, c = trio(client)
    gid = new_group(a)["id"]
    assert len(a.get(f"/api/groups/{gid}").json()["keys"]) == 1
    assert b.post(f"/api/groups/{gid}/keys/1/ack").json() == {"ok": True}
    # bob's copy is gone from what the server hands out, the others still have theirs
    assert b.get(f"/api/groups/{gid}").json()["keys"] == []
    assert len(a.get(f"/api/groups/{gid}").json()["keys"]) == 1
    assert len(c.get(f"/api/groups/{gid}").json()["keys"]) == 1
    with db.connect() as conn:
        row = conn.execute("SELECT iv, wk, consumed FROM chat_group_keys WHERE group_id = ? AND version = 1 AND user_id = "
                           "(SELECT id FROM users WHERE username = 'bob')", (gid,)).fetchone()
    assert (row["iv"], row["wk"], row["consumed"]) == ("", "", 1)


def test_a_member_who_acked_can_still_write(client):
    a, b, c = trio(client)
    gid = new_group(a)["id"]
    b.post(f"/api/groups/{gid}/keys/1/ack")
    with b.websocket_connect("/ws", headers=ORIGIN) as wb:
        drain(wb)
        assert of_type(send(wb, gm(gid, 1, n=0)), "gmsg")


def test_ack_edge_cases(client):
    a, b, c = trio(client)
    gid = new_group(a)["id"]
    assert b.post(f"/api/groups/{gid}/keys/7/ack").status_code == 404  # no such version
    assert b.post("/api/groups/999/keys/1/ack").status_code == 404
    assert client.post(f"/api/groups/{gid}/keys/1/ack").status_code == 401
    # someone outside the group can't touch it
    d = make_user(client, "dave", "d")
    assert d.post(f"/api/groups/{gid}/keys/1/ack").status_code == 404
    # acking twice is harmless
    assert b.post(f"/api/groups/{gid}/keys/1/ack").status_code == 200
    assert b.post(f"/api/groups/{gid}/keys/1/ack").status_code == 200


def test_keys_from_before_forward_secrecy_cannot_be_destroyed(client):
    a, b, c = trio(client)
    gid = new_group(a)["id"]
    with db.connect() as conn:
        conn.execute("UPDATE chat_groups SET fs_version = 2 WHERE id = ?", (gid,))
    assert b.post(f"/api/groups/{gid}/keys/1/ack").status_code == 400
    assert len(b.get(f"/api/groups/{gid}").json()["keys"]) == 1


def test_senders_only_covers_forward_secret_versions(client):
    a, b, c = trio(client)
    gid = new_group(a)["id"]
    with a.websocket_connect("/ws", headers=ORIGIN) as wa:
        drain(wa)
        send(wa, gm(gid, 1, n=0))
    with db.connect() as conn:
        conn.execute("UPDATE chat_groups SET fs_version = 2 WHERE id = ?", (gid,))
    assert a.get(f"/api/groups/{gid}").json()["senders"] == []


def test_existing_groups_are_rekeyed_once_when_the_server_updates(client):
    a, b, c = trio(client)
    gid = new_group(a)["id"]
    with db.connect() as conn:
        conn.execute("UPDATE chat_groups SET key_version = 3, rekey_needed = 0 WHERE id = ?", (gid,))
        conn.execute("ALTER TABLE chat_groups DROP COLUMN fs_version")  # a database from before
    db.init_db()
    g = a.get(f"/api/groups/{gid}").json()
    assert g["fs_version"] == 4 and g["rekey_needed"] is True
    # starting the server again must not do it a second time
    with db.connect() as conn:
        conn.execute("UPDATE chat_groups SET rekey_needed = 0 WHERE id = ?", (gid,))
    db.init_db()
    g = a.get(f"/api/groups/{gid}").json()
    assert g["fs_version"] == 4 and g["rekey_needed"] is False
