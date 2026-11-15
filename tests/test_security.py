import time

import pytest
from fastapi.testclient import TestClient
from starlette.applications import Starlette
from starlette.requests import HTTPConnection
from starlette.responses import JSONResponse, PlainTextResponse
from starlette.routing import Route, WebSocketRoute

from backend import security


def conn(headers=None, scheme="http", client=("203.0.113.9", 5000)):
    """A request the way the server sees it."""
    raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    return HTTPConnection(
        {
            "type": "http",
            "scheme": scheme,
            "server": ("testserver", 80),
            "path": "/",
            "query_string": b"",
            "headers": raw,
            "client": client,
        }
    )


@pytest.fixture(autouse=True)
def no_proxy(monkeypatch):
    monkeypatch.delenv("CIPHER_PROXY_HOPS", raising=False)
    monkeypatch.delenv("CIPHER_SECURE_COOKIES", raising=False)


def test_the_policy_allows_no_inline_code():
    assert "unsafe-inline" not in security.CSP
    assert "unsafe-eval" not in security.CSP
    assert "script-src 'self'" in security.CSP
    assert "style-src 'self'" in security.CSP


def test_the_policy_forbids_framing_plugins_and_base_tags():
    for part in ("frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'"):
        assert part in security.CSP
