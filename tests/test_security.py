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
