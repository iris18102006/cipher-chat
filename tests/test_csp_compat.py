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


def test_no_page_has_inline_styles_or_event_handlers():
    for page in PAGES:
        text = page.read_text()
        assert "<style" not in text, page.name
        assert not re.search(r"\sstyle\s*=", text), page.name
        assert not re.search(r"\son[a-z]+\s*=\s*[\"']", text), page.name
        assert "javascript:" not in text, page.name


def test_scripts_dont_write_inline_style_text_or_handler_attributes():
    for script in SCRIPTS:
        code = code_of(script)
        assert not re.search(r"setAttribute\(\s*[\"']style", code), script.name
        assert not re.search(r"setAttribute\(\s*[\"']on", code), script.name
        assert ".cssText" not in code, script.name
        assert "javascript:" not in code, script.name


def test_scripts_never_build_code_or_markup_from_text():
    for script in SCRIPTS:
        code = code_of(script)
        assert not re.search(r"\beval\(", code), script.name
        assert not re.search(r"new Function\(", code), script.name
        assert not re.search(r"set(Timeout|Interval)\(\s*[\"'`]", code), script.name
        assert not re.search(r"\.(inner|outer)HTML\s*[+]?=", code), script.name
        assert "insertAdjacentHTML" not in code, script.name
        assert "document.write" not in code, script.name


def test_nothing_is_loaded_from_another_site():
    for page in PAGES:
        text = page.read_text()
        assert not re.search(r"<(script|img|iframe|audio|video|source|link)\b[^>]*\b(src|href)=[\"']?(https?:)?//", text), page.name
    for style in STYLES:
        assert not re.search(r"url\(\s*[\"']?(https?:)?//", style.read_text()), style.name
        assert "@import" not in style.read_text(), style.name
    for script in SCRIPTS:
        code = code_of(script)
        assert not re.search(r"fetch\(\s*[\"'`]https?://", code), script.name
        assert not re.search(r"new WebSocket\(\s*[\"'`]wss?://", code), script.name
