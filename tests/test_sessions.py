def test_session_list_and_revoke_other_sessions(client):
    a = client.post("/api/signup", json={"username": "alice", "password": "password123"})
    assert a.status_code == 200
    first = client.cookies.get("session")
    other = client.post("/api/login", json={"username": "alice", "password": "password123"})
    assert other.status_code == 200
    listed = client.get("/api/sessions")
    assert listed.status_code == 200
    assert len(listed.json()["sessions"]) == 2
    revoked = client.delete("/api/sessions/other")
    assert revoked.json()["revoked"] == 1
    assert len(client.get("/api/sessions").json()["sessions"]) == 1
