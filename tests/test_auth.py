from fastapi.testclient import TestClient

from tests.test_backend import signup


def test_signup_lowercases_the_username(client):
    r = client.post("/api/signup", json={"username": "MiXeD_Case", "password": "password123"})
    assert r.status_code == 200
    assert r.json()["username"] == "mixed_case"
    assert isinstance(r.json()["rm"], str) and r.json()["rm"]


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
    assert r.json()["username"] == "trimmed"
    assert isinstance(r.json()["rm"], str)


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


def test_app_theme_roundtrip(client):
    a = signup(client, "alice")
    assert a.get("/api/app-theme").json() == {"app_theme": "classic"}
    assert a.get("/api/me").json()["app_theme"] == "classic"
    r = a.put("/api/app-theme", json={"app_theme": "neon"})
    assert r.status_code == 200 and r.json() == {"app_theme": "neon"}
    assert a.get("/api/app-theme").json() == {"app_theme": "neon"}
    assert a.get("/api/me").json()["app_theme"] == "neon"


def test_app_theme_rejects_unknown(client):
    a = signup(client, "alice")
    assert a.put("/api/app-theme", json={"app_theme": "nope"}).status_code == 400


def test_login_and_signup_return_a_remember_me_token(client):
    a = signup(client, "alice")
    r = a.post("/api/login", json={"username": "alice", "password": "password123"})
    assert r.status_code == 200
    rm = r.json()["rm"]
    assert isinstance(rm, str) and len(rm) > 10
    b = signup(client, "bob")
    assert isinstance(b.post("/api/login", json={"username": "bob", "password": "password123"}).json()["rm"], str)
    # tokens are per account
    assert b.post("/api/login", json={"username": "bob", "password": "password123"}).json()["rm"] != rm


def test_remember_me_reestablishes_the_session(client):
    a = signup(client, "alice")
    rm = a.post("/api/login", json={"username": "alice", "password": "password123"}).json()["rm"]

    # a fresh client has no cookie: it would be a logged-out visitor
    c = TestClient(client.app)
    c.portal = client.portal
    assert c.get("/api/me").status_code == 401
    ok = c.get("/api/session-with-rm", params={"token": rm})
    assert ok.status_code == 200 and ok.json() == {"ok": True}
    assert c.get("/api/me").json()["username"] == "alice"
    # unknown or missing tokens are refused
    assert c.get("/api/session-with-rm", params={"token": "nope"}).status_code == 401
    assert c.get("/api/session-with-rm").status_code == 401
    # logging out clears it, so the next visit starts logged out
    assert a.post("/api/logout").status_code == 200
    assert c.get("/api/session-with-rm", params={"token": rm}).status_code == 401


def test_login_ignores_case_and_spaces_in_the_username(client):
    signup(client, "alice")
    r = client.post("/api/login", json={"username": "  ALICE ", "password": "password123"})
    assert r.status_code == 200
    assert r.json()["username"] == "alice"
    assert isinstance(r.json()["rm"], str) and r.json()["rm"]


def test_every_login_gets_its_own_session_token(client):
    signup(client, "alice")
    creds = {"username": "alice", "password": "password123"}
    first = client.post("/api/login", json=creds).headers["set-cookie"].split(";")[0]
    second = client.post("/api/login", json=creds).headers["set-cookie"].split(";")[0]
    assert first != second


def test_session_tokens_are_stored_hashed(client):
    from backend import db

    a = signup(client, "alice")
    token = a.cookies.get("session")
    conn = db.connect()
    try:
        stored = [row["token"] for row in conn.execute("SELECT token FROM sessions")]
    finally:
        conn.close()
    assert token and len(stored) == 1
    assert token not in stored


def test_login_page_is_public(client):
    r = client.get("/login.html")
    assert r.status_code == 200
    assert "Member Login" in r.text


def test_chat_page_loads_when_logged_in(client):
    a = signup(client, "alice")
    r = a.get("/", follow_redirects=False)
    assert r.status_code == 200
    assert 'id="composer"' in r.text


def test_unknown_page_is_a_404(client):
    assert client.get("/nope.html").status_code == 404
