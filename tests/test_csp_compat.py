"""The Content-Security-Policy in backend/security.py only works while the page keeps to it.

These tests read the files in web/ and fail when somebody adds something the policy would block, so
it is found here and not by a chat that stopped working in the browser.
"""

import re
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"
PAGES = sorted(WEB.glob("*.html"))
SCRIPTS = sorted(WEB.glob("*.js"))
STYLES = sorted(WEB.glob("*.css"))


def code_of(path):
    """A script without its comments, so a sentence like "never use innerHTML" doesn't count."""
    text = path.read_text()
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"(?m)^\s*//.*$", "", text)


def test_there_is_something_to_check():
    assert PAGES and SCRIPTS and STYLES


def test_no_page_has_an_inline_script():
    for page in PAGES:
        for tag in re.findall(r"<script\b[^>]*>", page.read_text()):
            assert re.search(r"\bsrc=", tag), (page.name, tag)
        assert not re.search(r"<script\b[^>]*>\s*[^<\s]", page.read_text()), page.name
