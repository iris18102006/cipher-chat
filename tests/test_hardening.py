import time

import pytest
from fastapi.testclient import TestClient

from backend import main, security
from tests.test_backend import signup
from tests.test_blobs import upload


def test_pages_carry_the_security_headers(client):
    for path in ("/login.html", "/app.js", "/style.css", "/fonts/lora.woff2"):
        r = client.get(path)
        assert r.status_code == 200, path
        for name, value in security.SECURITY_HEADERS.items():
            assert r.headers[name] == value, (path, name)


def test_the_redirect_for_logged_out_visitors_has_them_too(client):
    r = client.get("/", follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["x-frame-options"] == "DENY"
    assert r.headers["content-security-policy"] == security.CSP


def test_api_answers_are_not_cached(client):
    a = signup(client, "alice")
    for r in (a.get("/api/me"), a.get("/api/friends"), client.get("/api/me")):
        assert r.headers["content-type"].startswith("application/json")
        assert r.headers["cache-control"] == "no-store"
        assert r.headers["x-content-type-options"] == "nosniff"


def test_files_keep_their_own_stricter_policy(client, tmp_path, monkeypatch):
    monkeypatch.setattr(main.blobs, "BLOB_DIR", tmp_path / "blobs")
    a = signup(client, "alice")
    blob_id = upload(a, [b"x" * 50])
    r = a.get(f"/api/blobs/{blob_id}/pieces/0")
    assert r.headers["content-security-policy"] == "default-src 'none'; sandbox"
    assert r.headers["cache-control"] == "private, max-age=3600"
    assert r.headers["x-frame-options"] == "DENY"


def sign_up(c, name="alice", headers=None):
    return c.post("/api/signup", json={"username": name, "password": "password123"}, headers=headers or {})


def is_secure(r):
    return "; secure" in r.headers["set-cookie"].lower()


@pytest.fixture()
def auto_cookies(monkeypatch):
    monkeypatch.delenv("CIPHER_SECURE_COOKIES", raising=False)
    monkeypatch.delenv("CIPHER_PROXY_HOPS", raising=False)


def test_the_session_cookie_is_not_secure_over_plain_http(client, auto_cookies):
    r = sign_up(client)
    assert r.status_code == 200
    assert not is_secure(r)
    assert "httponly" in r.headers["set-cookie"].lower()


def test_the_session_cookie_is_secure_over_https(client, auto_cookies):
    r = sign_up(TestClient(main.app, base_url="https://testserver"))
    assert r.status_code == 200
    assert is_secure(r)


def test_logging_in_over_https_is_secure_too(client, auto_cookies):
    signup(client, "alice")
    https = TestClient(main.app, base_url="https://testserver")
    r = https.post("/api/login", json={"username": "alice", "password": "password123"})
    assert r.status_code == 200
    assert is_secure(r)


@pytest.mark.parametrize("mode, scheme, expected", [("1", "http", True), ("0", "https", False)])
def test_the_cookie_setting_can_force_the_flag(client, auto_cookies, monkeypatch, mode, scheme, expected):
    monkeypatch.setenv("CIPHER_SECURE_COOKIES", mode)
    r = sign_up(TestClient(main.app, base_url=f"{scheme}://testserver"))
    assert is_secure(r) is expected


def test_the_cookie_is_secure_behind_a_proxy_that_speaks_https(client, auto_cookies, monkeypatch):
    monkeypatch.setenv("CIPHER_PROXY_HOPS", "1")
    r = sign_up(client, headers={"X-Forwarded-Proto": "https"})
    assert is_secure(r)


def test_a_forwarded_proto_header_means_nothing_without_a_proxy(client, auto_cookies):
    r = sign_up(client, headers={"X-Forwarded-Proto": "https"})
    assert not is_secure(r)


def bad_login(c, name, headers=None):
    r = c.post("/api/login", json={"username": name, "password": "wrong-pass"}, headers=headers or {})
    return r.status_code


def test_one_address_cant_guess_across_many_usernames(client, monkeypatch):
    monkeypatch.setattr(main.ip_fail_limiter, "limit", 3)
    assert [bad_login(client, f"user{i}") for i in range(5)] == [401, 401, 401, 429, 429]


def test_a_good_login_does_not_reset_the_address_count(client, monkeypatch):
    signup(client, "alice")
    monkeypatch.setattr(main.ip_fail_limiter, "limit", 3)
    assert [bad_login(client, "user1"), bad_login(client, "user2")] == [401, 401]
    good = client.post("/api/login", json={"username": "alice", "password": "password123"})
    assert good.status_code == 200
    assert bad_login(client, "user3") == 401
    assert bad_login(client, "user4") == 429


def test_the_real_address_is_used_behind_a_proxy(client, monkeypatch):
    monkeypatch.setenv("CIPHER_PROXY_HOPS", "1")
    monkeypatch.setattr(main.ip_fail_limiter, "limit", 2)

    def bad(ip, name):
        return bad_login(client, name, {"X-Forwarded-For": ip})

    assert [bad("198.51.100.1", n) for n in ("a1", "b1", "c1")] == [401, 401, 429]
    # somebody else behind the same proxy isn't locked out by it
    assert bad("198.51.100.2", "a1") == 401


def test_a_made_up_forwarded_address_doesnt_dodge_the_limit(client, monkeypatch):
    monkeypatch.setenv("CIPHER_PROXY_HOPS", "1")
    monkeypatch.setattr(main.ip_fail_limiter, "limit", 2)
    codes = [bad_login(client, f"u{i}", {"X-Forwarded-For": f"6.6.6.{i}, 198.51.100.1"}) for i in range(3)]
    assert codes == [401, 401, 429]


def test_forwarded_addresses_mean_nothing_without_a_proxy(client, monkeypatch):
    monkeypatch.delenv("CIPHER_PROXY_HOPS", raising=False)
    monkeypatch.setattr(main.ip_fail_limiter, "limit", 2)
    codes = [bad_login(client, f"u{i}", {"X-Forwarded-For": f"6.6.6.{i}"}) for i in range(3)]
    assert codes == [401, 401, 429]


def test_one_address_can_only_make_so_many_accounts(client, monkeypatch):
    monkeypatch.setattr(main.signup_limiter, "limit", 2)
    results = [sign_up(client, name) for name in ("aaa", "bbb", "ccc")]
    assert [r.status_code for r in results] == [200, 200, 429]
    assert "too many accounts" in results[2].json()["detail"]


def test_signups_refused_for_other_reasons_dont_count(client, monkeypatch):
    monkeypatch.setattr(main.signup_limiter, "limit", 2)
    assert sign_up(client, "x").status_code == 400
    assert sign_up(client, "A B").status_code == 400
    short = client.post("/api/signup", json={"username": "short_pw", "password": "short"})
    assert short.status_code == 400
    assert [sign_up(client, name).status_code for name in ("aaa", "bbb", "ccc")] == [200, 200, 429]


def test_each_address_has_its_own_signup_count(client, monkeypatch):
    monkeypatch.setenv("CIPHER_PROXY_HOPS", "1")
    monkeypatch.setattr(main.signup_limiter, "limit", 1)
    first = {"X-Forwarded-For": "198.51.100.1"}
    other = {"X-Forwarded-For": "198.51.100.2"}
    assert sign_up(client, "aaa", first).status_code == 200
    assert sign_up(client, "bbb", first).status_code == 429
    assert sign_up(client, "ccc", other).status_code == 200
