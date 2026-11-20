"""Keeping the feed clean: rules for the words of a post, and an optional check on pictures.

Be honest about what this is. Nothing on a small self-hosted server can promise that no bad
picture or video ever gets through. So the feed has layers:

1. Posts are only ever shown to friends (never to the whole internet), and "close friends" and
   "only me" make that smaller.
2. Words: threats and "kill yourself" style messages are refused (check_text below).
3. Pictures: every picture is decoded and saved again (so it really is a picture and carries no
   hidden data). If you turn on the picture check (CIPHER_IMAGE_CHECK=nudenet) pictures that
   show exposed nudity are refused too. Videos and songs can't be checked by the server.
4. Reports: anybody can report a post. When enough different people do, the post is hidden
   until a person looks at it (see feed.py). That is what covers videos and songs.

This file imports nothing from main.py so it can be tested on its own.
"""

import io
import logging
import os
import re
import tempfile
from pathlib import Path

from PIL import Image

log = logging.getLogger("cipher")

# ---------- words ----------

# Deliberately short and careful: a word list that is too eager blocks normal people. Add your
# own phrases (one per line) to backend/blocked_terms.txt. They are matched as whole words.
BUILT_IN = [
    # threats against a person
    r"\bi(?:'ll|\s+will|'m\s+going\s+to|\s+am\s+going\s+to|'m\s+gonna|\s+am\s+gonna|\s+gonna|\s+wanna|\s+want\s+to)\s+(?:kill|murder|shoot|stab|strangle|rape)\s+(?:you|u|ya|him|her|them)\b",
    r"\b(?:i(?:'ll|\s+will)\s+find\s+you\s+and\s+(?:kill|hurt|beat))\b",
    # telling somebody to hurt themselves
    r"\b(?:go\s+)?(?:kill|hang|off)\s+(?:yourself|urself|yourselves)\b",
    r"\bkys\b",
    # selling or trading explicit pictures
    r"\b(?:send|sell|selling|buy|trade|trading)\s+(?:me\s+)?(?:nudes|nude\s+pics?|nude\s+photos?)\b",
]

TERMS_FILE = Path(__file__).parent / "blocked_terms.txt"


def _compile_extra() -> list[re.Pattern]:
    """The phrases from blocked_terms.txt, each matched as whole words."""
    try:
        lines = TERMS_FILE.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    out = []
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        out.append(re.compile(r"\b" + re.escape(line.lower()).replace(r"\ ", r"\s+") + r"\b", re.I))
    return out


_RULES = [re.compile(p, re.I) for p in BUILT_IN]
_EXTRA = _compile_extra()

TEXT_REFUSED = "that breaks the rules: no threats, no telling people to hurt themselves and no explicit stuff"


def _squash(text: str) -> str:
    """Make 'k i l l  y o u' and 'kill   you' and curly apostrophes look the same as plain text."""
    text = text.replace("\u2019", "'").replace("\u2018", "'")
    return re.sub(r"\s+", " ", text)


def check_text(text: str) -> str | None:
    """None if the words are fine, otherwise a reason to show the person."""
    flat = _squash(text)
    for rule in (*_RULES, *_EXTRA):
        if rule.search(flat):
            return TEXT_REFUSED
    return None


# ---------- pictures ----------

IMAGE_REFUSED = "that picture can't be posted here (no nudity, violence or anything harmful)"
IMAGE_UNAVAILABLE = "pictures can't be checked right now, try again a little later"

