"""Deleting a whole conversation: for yourself, or for both of you."""
from backend import main  # noqa: F401  (main has to be imported first)
from tests.test_groups import trio




def put_messages(sender, recipient, count):
    from backend import db

    conn = db.connect()
    try:
        s = conn.execute("SELECT id FROM users WHERE username = ?", (sender,)).fetchone()[0]
        r = conn.execute("SELECT id FROM users WHERE username = ?", (recipient,)).fetchone()[0]
        for i in range(count):
            conn.execute("INSERT INTO messages (sender_id, recipient_id, iv, ct) VALUES (?, ?, 'aXY=', ?)", (s, r, f"ct{i}"))
        conn.commit()
    finally:
        conn.close()


def ids(c, peer):
    return [m["ct"] for m in c.get(f"/api/messages/{peer}").json()]


def test_delete_for_me_only_empties_my_side(client):
    a, b, _ = trio(client)
    put_messages("alice", "bob", 2)
    put_messages("bob", "alice", 1)
    assert a.delete("/api/messages/bob").status_code == 200
    assert ids(a, "bob") == [] and len(ids(b, "alice")) == 3
    put_messages("bob", "alice", 1)  # new messages after that show up again
    assert ids(a, "bob") == ["ct0"]


def test_delete_for_me_clears_the_unread_count(client):
    a, b, _ = trio(client)
    put_messages("bob", "alice", 3)
    a.delete("/api/messages/bob")
    assert [c["unread"] for c in a.get("/api/contacts").json() if c["username"] == "bob"] == [0]


def test_delete_for_everyone_removes_it_for_both(client):
    a, b, c = trio(client)
    put_messages("alice", "bob", 2)
    put_messages("bob", "alice", 2)
    put_messages("alice", "carol", 1)
    assert a.delete("/api/messages/bob", params={"everyone": "true"}).status_code == 200
    assert ids(a, "bob") == [] and ids(b, "alice") == []
    assert len(ids(a, "carol")) == 1  # other chats are left alone


def test_unknown_person_and_logged_out(client):
    a, _, _ = trio(client)
    assert a.delete("/api/messages/nobody").status_code == 404
    client.cookies.clear()
    assert client.delete("/api/messages/bob").status_code in (401, 403)
