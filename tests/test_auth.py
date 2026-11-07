from tests.test_backend import signup


def test_signup_lowercases_the_username(client):
    r = client.post("/api/signup", json={"username": "MiXeD_Case", "password": "password123"})
    assert r.status_code == 200
    assert r.json() == {"username": "mixed_case"}


def test_signup_rejects_symbols_in_the_username(client):
    for bad in ("bad name", "bad-name", "bad.name", "bad!", "emile\u0301"):
        r = client.post("/api/signup", json={"username": bad, "password": "password123"})
        assert r.status_code == 400, bad


def test_signup_username_too_long(client):
    r = client.post("/api/signup", json={"username": "a" * 21, "password": "password123"})
    assert r.status_code == 400


def test_signup_username_edges_are_allowed(client):
    for name in ("abc", "a" * 20):
        r = client.post("/api/signup", json={"username": name, "password": "password123"})
        assert r.status_code == 200, name


def test_signup_password_length_limits(client):
    def attempt(name, pw):
        return client.post("/api/signup", json={"username": name, "password": pw}).status_code

    assert attempt("pw_short", "1234567") == 400
    assert attempt("pw_min", "12345678") == 200
    assert attempt("pw_max", "x" * 128) == 200
    assert attempt("pw_long", "x" * 129) == 400


def test_signup_trims_spaces_around_the_username(client):
    r = client.post("/api/signup", json={"username": "  trimmed  ", "password": "password123"})
    assert r.status_code == 200
    assert r.json() == {"username": "trimmed"}


def test_logout_ends_the_session(client):
    a = signup(client, "alice")
    assert a.get("/api/me").status_code == 200
    assert a.post("/api/logout").status_code == 200
    assert a.get("/api/me").status_code == 401


def test_me_needs_a_login(client):
    assert client.get("/api/me").status_code == 401


def test_session_cookie_is_httponly_and_samesite(client):
    r = client.post("/api/signup", json={"username": "alice", "password": "password123"})
    cookie = r.headers["set-cookie"].lower()
    assert cookie.startswith("session=")
    assert "httponly" in cookie
    assert "samesite=lax" in cookie
