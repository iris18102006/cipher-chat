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
