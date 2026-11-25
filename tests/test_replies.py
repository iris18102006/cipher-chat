"""Replies in chats: the sender picks a message, the reply carries its id, and the
history of both sides reports it. (The text stays encrypted server-side, so the quote
is built from what each browser has already decrypted.)"""

from tests.test_backend import signup, ORIGIN


def recv(ws, want):
    """read ws messages until one of type `want` arrives (presence events are skipped)"""
    while True:
        d = ws.receive_json()
        if d["type"] == want:
            return d


def test_reply_flow_and_history(client):
    a, b = signup(client, "alice"), signup(client, "bob")
    a.post("/api/friends/bob")
    b.post("/api/friends/alice/accept")
    with a.websocket_connect("/ws", headers=ORIGIN) as wa:
        assert wa.receive_json()["type"] == "ready"
        with b.websocket_connect("/ws", headers=ORIGIN) as wb:
            assert wb.receive_json()["type"] == "ready"

            wa.send_json({"type": "msg", "to": "bob", "iv": "aXY=", "ct": "Y3Q=", "cid": "m1"})
            got = recv(wb, "msg")
            assert got["from"] == "alice" and got["replied_to"] is None
            assert recv(wa, "msg")["id"] == got["id"]  # the echo of our own message, a

            wb.send_json(
                {"type": "msg", "to": "alice", "iv": "aXY=", "ct": "Y3Qy", "cid": "m2", "replied_to": got["id"]}
            )
            echo = recv(wa, "msg")
            assert echo["type"] == "msg"
            assert echo["replied_to"] == got["id"]
            assert echo["replied_from"] == "alice"  # the person who wrote the message being replied to

    hist = b.get("/api/messages/alice").json()
    assert len(hist) == 2
    assert hist[0]["replied_to"] is None
    assert hist[1]["replied_to"] == got["id"]
    assert hist[1]["replied_from"] == "alice"


def test_reply_to_own_sent_message_and_bad_ids(client):
    a, b = signup(client, "alice"), signup(client, "bob")
    a.post("/api/friends/bob")
    b.post("/api/friends/alice/accept")
    with a.websocket_connect("/ws", headers=ORIGIN) as wa:
        assert wa.receive_json()["type"] == "ready"
        with b.websocket_connect("/ws", headers=ORIGIN) as wb:
            assert wb.receive_json()["type"] == "ready"

            wa.send_json({"type": "msg", "to": "bob", "iv": "aXY=", "ct": "Y3Q=", "cid": "m1"})
            assert recv(wb, "msg")["from"] == "alice"
            msg_id = recv(wa, "msg")["id"]

            # alice replies to her own message
            wa.send_json({"type": "msg", "to": "bob", "iv": "aXY=", "ct": "Y3Qy", "cid": "m2", "replied_to": msg_id})
            assert recv(wb, "msg")["replied_to"] == msg_id

            # reply ids that aren't numbers in this conversation are dropped, not stored
            wa.send_json({"type": "msg", "to": "bob", "iv": "aXY=", "ct": "aGk=", "cid": "m3", "replied_to": "bogus"})
            wa.send_json({"type": "msg", "to": "bob", "iv": "aXY=", "ct": "aGk=", "cid": "m4", "replied_to": True})

    hist = a.get("/api/messages/bob").json()
    assert [r["replied_to"] for r in hist] == [None, msg_id]
