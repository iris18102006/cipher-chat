import re
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"


def page(name):
    return (WEB / name).read_text()


def test_every_script_index_loads_exists():
    for src in re.findall(r'<script src="([^"]+)"', page("index.html")):
        assert (WEB / src).is_file(), src
