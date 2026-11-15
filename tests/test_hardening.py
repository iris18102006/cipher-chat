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
