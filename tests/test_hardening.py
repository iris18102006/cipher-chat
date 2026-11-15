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
