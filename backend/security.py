"""Security helpers for cipher-chat: response headers, rate limiting and who is really connecting.

This file imports nothing from main.py, so main.py, blobs.py and the tests can all use it.
"""

import os
import time
from collections import defaultdict

from starlette.datastructures import MutableHeaders
from starlette.requests import HTTPConnection


# What a page of cipher-chat is allowed to load. Everything comes from our own address: no inline
# scripts or styles and no other sites. data: is for the little svg shapes in the css and blob: is
# for files and pictures that were unlocked in your browser.
CSP = "; ".join(
    (
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "font-src 'self'",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    )
)


# Only our own pages may use the microphone (voice messages). Nothing here needs the rest.
PERMISSIONS_POLICY = "microphone=(self), camera=(), geolocation=(), payment=(), usb=()"


# Nobody else's page gets a window into ours, or gets to load our answers as its own.
CROSS_ORIGIN_HEADERS = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
}


# Only sent over https. Six months, and not for subdomains, so it can't lock anything else out.
HSTS = "max-age=15552000"


SECURITY_HEADERS = {
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": PERMISSIONS_POLICY,
    **CROSS_ORIGIN_HEADERS,
}


def proxy_hops() -> int:
    """How many reverse proxies (nginx, Caddy...) sit in front of this server, 0 if people connect directly.

    Only when this is set are X-Forwarded-For and X-Forwarded-Proto believed, because anybody can send
    those headers. Set it with CIPHER_PROXY_HOPS.
    """
    try:
        return max(0, int(os.environ.get("CIPHER_PROXY_HOPS", "0")))
    except ValueError:
        return 0


def client_ip(conn: HTTPConnection) -> str:
    """The address a request really came from.

    With CIPHER_PROXY_HOPS=1 (one proxy in front) that is the last address in X-Forwarded-For, the one
    our own proxy added. The ones before it were sent by the client and could be made up.
    """
    hops = proxy_hops()
    if hops:
        parts = [p.strip() for p in conn.headers.get("x-forwarded-for", "").split(",") if p.strip()]
        if len(parts) >= hops:
            return parts[-hops]
    return conn.client.host if conn.client else "?"


def is_https(conn: HTTPConnection) -> bool:
    """Was this request made over https? Behind a proxy the proxy says so in X-Forwarded-Proto."""
    if conn.url.scheme in ("https", "wss"):
        return True
    if proxy_hops() == 0:
        return False
    return conn.headers.get("x-forwarded-proto", "").split(",")[-1].strip().lower() == "https"


def cookie_secure(conn: HTTPConnection) -> bool:
    """Should the session cookie be marked Secure (only ever sent over https)?

    CIPHER_SECURE_COOKIES=1 always, =0 never, and when it isn't set: whenever this request is https.
    """
    mode = os.environ.get("CIPHER_SECURE_COOKIES", "").strip()
    if mode == "1":
        return True
    if mode == "0":
        return False
    return is_https(conn)


class Pruner:
    """Forgets the keys of a {key: [timestamps]} dict once all of their timestamps are too old.

    A rate limiter only looks at a key when it comes back, so keys that never come back would pile
    up for as long as the server runs. maybe() is cheap enough to call on every request: it only
    does the work once every `every` seconds.
    """

    def __init__(self, store: dict, window: float, every: float = 60.0):
        self.store = store
        self.window = window
        self.every = every
        self.last = 0.0

    def maybe(self, now: float | None = None) -> int:
        now = time.time() if now is None else now
        if now - self.last < self.every:
            return 0
        self.last = now
        stale = [key for key, times in list(self.store.items()) if not times or now - times[-1] >= self.window]
        for key in stale:
            self.store.pop(key, None)
        return len(stale)


class SlidingLimiter:
    """Counts events per key (an address, say) over a sliding window of `window` seconds."""

    def __init__(self, limit: int, window: float):
        self.limit = limit
        self.window = window
        self.hits: dict[str, list[float]] = defaultdict(list)
        self._pruner = Pruner(self.hits, window)

    def blocked(self, key: str) -> bool:
        """Has this key used up its events? Looking never counts as an event."""
        self._pruner.maybe()
        now = time.time()
        recent = [t for t in self.hits.get(key, ()) if now - t < self.window]
        return len(recent) >= self.limit

    def hit(self, key: str) -> None:
        now = time.time()
        recent = [t for t in self.hits.get(key, ()) if now - t < self.window]
        recent.append(now)
        self.hits[key] = recent

    def clear(self) -> None:
        self.hits.clear()


class SecurityHeaders:
    """ASGI middleware that adds the headers above to every page and every answer.

    A header the route already set is left alone, so files and songs keep their own, stricter policy.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        # websockets and the startup call pass straight through
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        secure = is_https(HTTPConnection(scope))

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                for name, value in SECURITY_HEADERS.items():
                    if name not in headers:
                        headers[name] = value
                if secure:
                    headers.setdefault("Strict-Transport-Security", HSTS)
            await send(message)

        await self.app(scope, receive, send_with_headers)
