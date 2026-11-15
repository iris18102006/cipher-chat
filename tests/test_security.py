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


def test_the_policy_still_allows_what_the_app_needs():
    assert "img-src 'self' data: blob:" in security.CSP
    assert "media-src 'self' blob:" in security.CSP
    assert "connect-src 'self'" in security.CSP
    assert "font-src 'self'" in security.CSP


def test_only_our_own_pages_get_the_microphone():
    assert "microphone=(self)" in security.PERMISSIONS_POLICY
    assert "camera=()" in security.PERMISSIONS_POLICY


def test_client_ip_is_the_socket_address_without_a_proxy():
    # anybody can send this header, so without a proxy it means nothing
    assert security.client_ip(conn({"X-Forwarded-For": "198.51.100.1"})) == "203.0.113.9"


def test_client_ip_behind_one_proxy_is_the_last_address(monkeypatch):
    monkeypatch.setenv("CIPHER_PROXY_HOPS", "1")
    assert security.client_ip(conn({"X-Forwarded-For": "198.51.100.7"})) == "198.51.100.7"


def test_client_ip_ignores_addresses_the_client_made_up(monkeypatch):
    monkeypatch.setenv("CIPHER_PROXY_HOPS", "1")
    assert security.client_ip(conn({"X-Forwarded-For": "6.6.6.6, 198.51.100.7"})) == "198.51.100.7"


def test_client_ip_behind_two_proxies(monkeypatch):
    monkeypatch.setenv("CIPHER_PROXY_HOPS", "2")
    assert security.client_ip(conn({"X-Forwarded-For": "6.6.6.6, 198.51.100.7, 10.0.0.2"})) == "198.51.100.7"


def test_client_ip_falls_back_when_the_proxy_header_is_missing(monkeypatch):
    monkeypatch.setenv("CIPHER_PROXY_HOPS", "1")
    assert security.client_ip(conn()) == "203.0.113.9"


def test_a_garbage_proxy_count_means_no_proxy(monkeypatch):
    monkeypatch.setenv("CIPHER_PROXY_HOPS", "lots")
    assert security.proxy_hops() == 0
    monkeypatch.setenv("CIPHER_PROXY_HOPS", "-3")
    assert security.proxy_hops() == 0


def test_https_is_seen_from_the_scheme():
    assert security.is_https(conn(scheme="https"))
    assert not security.is_https(conn())


def test_forwarded_proto_only_counts_behind_a_proxy(monkeypatch):
    headers = {"X-Forwarded-Proto": "https"}
    assert not security.is_https(conn(headers))
    monkeypatch.setenv("CIPHER_PROXY_HOPS", "1")
    assert security.is_https(conn(headers))
    assert not security.is_https(conn({"X-Forwarded-Proto": "http"}))


def test_cookies_are_secure_when_asked_never_or_automatically(monkeypatch):
    assert security.cookie_secure(conn(scheme="https")) is True
    assert security.cookie_secure(conn()) is False
    monkeypatch.setenv("CIPHER_SECURE_COOKIES", "1")
    assert security.cookie_secure(conn()) is True
    monkeypatch.setenv("CIPHER_SECURE_COOKIES", "0")
    assert security.cookie_secure(conn(scheme="https")) is False


def test_the_pruner_forgets_keys_that_never_came_back():
    now = 10_000.0
    store = {"old": [now - 500], "empty": [], "fresh": [now - 5]}
    pruner = security.Pruner(store, window=300)
    assert pruner.maybe(now) == 2
    assert list(store) == ["fresh"]


def test_the_pruner_only_works_once_a_minute():
    store = {"old": [1.0]}
    pruner = security.Pruner(store, window=300)
    assert pruner.maybe(1000.0) == 1
    store["old2"] = [1.0]
    assert pruner.maybe(1030.0) == 0
    assert "old2" in store
    assert pruner.maybe(1061.0) == 1


def test_a_limiter_blocks_after_its_limit():
    limiter = security.SlidingLimiter(limit=3, window=60)
    for _ in range(3):
        assert not limiter.blocked("a")
        limiter.hit("a")
    assert limiter.blocked("a")


def test_a_limiter_forgets_events_outside_the_window():
    limiter = security.SlidingLimiter(limit=2, window=60)
    limiter.hits["a"] = [time.time() - 120, time.time() - 90]
    assert not limiter.blocked("a")
    limiter.hit("a")
    assert len(limiter.hits["a"]) == 1


def test_limiter_keys_are_separate_and_looking_costs_nothing():
    limiter = security.SlidingLimiter(limit=1, window=60)
    limiter.hit("a")
    assert limiter.blocked("a")
    assert not limiter.blocked("b")
    assert "b" not in limiter.hits
    limiter.clear()
    assert not limiter.blocked("a")


def tiny_app(page_headers=None):
    async def page(request):
        return PlainTextResponse("hi", headers=page_headers)

    async def data(request):
        return JSONResponse({"ok": True})

    async def sock(ws):
        await ws.accept()
        await ws.send_text("hello")
        await ws.close()

    app = Starlette(routes=[Route("/", page), Route("/data", data), WebSocketRoute("/ws", sock)])
    app.add_middleware(security.SecurityHeaders)
    return app


def test_the_middleware_adds_every_header():
    r = TestClient(tiny_app()).get("/")
    for name, value in security.SECURITY_HEADERS.items():
        assert r.headers[name] == value


def test_the_middleware_keeps_a_header_the_route_set_itself():
    own = "default-src 'none'; sandbox"
    r = TestClient(tiny_app({"Content-Security-Policy": own})).get("/")
    assert r.headers["content-security-policy"] == own
    assert r.headers["x-frame-options"] == "DENY"


def test_hsts_is_only_sent_over_https():
    app = tiny_app()
    assert "strict-transport-security" not in TestClient(app).get("/").headers
    secure = TestClient(app, base_url="https://testserver").get("/")
    assert secure.headers["strict-transport-security"] == security.HSTS
