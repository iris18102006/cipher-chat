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
