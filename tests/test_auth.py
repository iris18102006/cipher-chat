from tests.test_backend import signup


def test_signup_lowercases_the_username(client):
    r = client.post("/api/signup", json={"username": "MiXeD_Case", "password": "password123"})
    assert r.status_code == 200
    assert r.json() == {"username": "mixed_case"}
