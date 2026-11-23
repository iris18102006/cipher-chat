def test_key_vault_is_opaque_and_replaceable(client):
    assert client.post("/api/signup", json={"username": "alice", "password": "password123"}).status_code == 200
    body = {
        "version": 1,
        "kdf": "PBKDF2-SHA-256",
        "salt": "c2FsdC1mb3ItdGVzdC0xNg==",
        "iv": "aXYtZm9yLXRlc3Q=",
        "ciphertext": "Y2lwaGVydGV4dC1lbmNyeXB0ZWQtbG9uZy1lbm91Z2g=",
    }
    assert client.put("/api/key-vault", json=body).status_code == 200
    got = client.get("/api/key-vault").json()["vault"]
    assert got["ciphertext"] == body["ciphertext"]
    assert client.put("/api/key-vault", json={**body, "ciphertext": body["ciphertext"] + "="}).status_code == 200
    assert client.delete("/api/key-vault").status_code == 200
    assert client.get("/api/key-vault").json()["vault"] is None


def test_key_vault_rejects_unknown_format(client):
    assert client.post("/api/signup", json={"username": "alice", "password": "password123"}).status_code == 200
    body = {"version": 99, "kdf": "plain", "salt": "abcdefghijklmnop", "iv": "abcdefghijklmnop", "ciphertext": "abcdefghijklmnopabcdefghijklmnop"}
    assert client.put("/api/key-vault", json=body).status_code == 400
