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
