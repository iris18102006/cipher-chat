import re
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"


def page(name):
    return (WEB / name).read_text()


def test_every_script_index_loads_exists():
    for src in re.findall(r'<script src="([^"]+)"', page("index.html")):
        assert (WEB / src).is_file(), src


def test_every_stylesheet_index_loads_exists():
    for href in re.findall(r'<link rel="stylesheet" href="([^"]+)"', page("index.html")):
        assert (WEB / href).is_file(), href


def test_no_script_is_left_unloaded():
    loaded = set()
    for name in ("index.html", "login.html"):
        loaded |= set(re.findall(r'<script src="([^"]+)"', page(name)))
    assert {p.name for p in WEB.glob("*.js")} == loaded


def test_no_stylesheet_is_left_unloaded():
    loaded = set()
    for name in ("index.html", "login.html"):
        loaded |= set(re.findall(r'<link rel="stylesheet" href="([^"]+)"', page(name)))
    assert {p.name for p in WEB.glob("*.css")} == loaded


def test_dialog_labels_point_at_real_ids():
    text = page("index.html")
    targets = re.findall(r'aria-labelledby="([^"]+)"', text)
    assert targets
    for target in targets:
        assert f'id="{target}"' in text, target


def test_close_buttons_have_a_label():
    buttons = re.findall(r"<button[^>]*>&times;</button>", page("index.html"))
    assert buttons
    for button in buttons:
        assert "aria-label=" in button, button


def test_login_labels_point_at_real_inputs():
    text = page("login.html")
    targets = re.findall(r'<label for="([^"]+)"', text)
    assert len(targets) == 4
    for target in targets:
        assert f'id="{target}"' in text, target


def test_ids_in_index_are_unique():
    ids = re.findall(r'\bid="([^"]+)"', page("index.html"))
    assert len(ids) == len(set(ids))


def test_every_page_has_a_description():
    for p in WEB.glob("*.html"):
        assert 'name="description"' in p.read_text(), p.name


def test_every_page_sets_a_theme_color():
    for p in WEB.glob("*.html"):
        assert 'name="theme-color"' in p.read_text(), p.name


def test_every_page_has_a_favicon():
    for p in WEB.glob("*.html"):
        assert 'rel="icon"' in p.read_text(), p.name


def test_every_page_has_a_noscript_message():
    for p in WEB.glob("*.html"):
        assert "<noscript>" in p.read_text(), p.name


def test_chat_inputs_are_labelled():
    text = page("index.html")
    assert re.search(r'id="msg"[^>]*aria-label=', text)
    assert re.search(r'id="search"[^>]*aria-label=', text)
    assert re.search(r'id="log"[^>]*role="log"', text)


def test_login_form_limits_match_the_backend():
    text = page("login.html")
    assert re.search(r'id="signup-user"[^>]*maxlength="20"', text)
    assert re.search(r'id="signup-pass"[^>]*minlength="8"', text)
    assert re.search(r'id="signup-pass"[^>]*maxlength="128"', text)
