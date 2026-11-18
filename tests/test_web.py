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
    # sw.js is not a script tag, the page registers it as a service worker (see streamsave.js)
    assert {p.name for p in WEB.glob("*.js")} - {"sw.js"} == loaded
    assert 'register("/sw.js"' in page("streamsave.js")


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


def test_every_login_field_is_required():
    text = page("login.html")
    for field in ("login-user", "login-pass", "signup-user", "signup-pass"):
        assert re.search(rf'id="{field}"[^>]*\brequired\b', text), field


def js_number(name):
    """A number like `4 * 1024 * 1024` out of web/filecrypto.js."""
    expr = re.search(rf"const {name} = ([\d\s*]+);", page("filecrypto.js")).group(1)
    n = 1
    for part in expr.split("*"):
        n *= int(part)
    return n


def test_file_piece_size_matches_the_backend():
    from backend import main

    assert js_number("FC_CHUNK") == main.blobs.CHUNK
    assert js_number("FC_TAG") == main.blobs.TAG


def test_file_size_limit_matches_the_backend():
    import os

    from backend import main

    assert js_number("FC_MAX_BYTES") == 2048 * 1024 * 1024
    if "CIPHER_MAX_FILE_MB" not in os.environ:
        assert main.blobs.MAX_FILE == js_number("FC_MAX_BYTES")


def test_voice_messages_stop_at_five_minutes():
    assert js_number("FC_VOICE_MAX_SECONDS") == 300


def test_file_buttons_exist_and_are_labelled():
    text = page("index.html")
    for ident in ("attach", "attach-input", "att-status", "att-cancel", "mic", "rec-bar", "rec-send", "rec-cancel", "rec-time", "rec-who"):
        assert f'id="{ident}"' in text, ident
    for ident in ("attach", "attach-input", "mic"):
        assert re.search(rf'id="{ident}"[^>]*aria-label="[^"]+"', text), ident


def test_file_scripts_load_in_order():
    srcs = re.findall(r'<script src="([^"]+)"', page("index.html"))
    assert srcs.index("crypto.js") < srcs.index("filecrypto.js") < srcs.index("attachments.js")
    assert srcs.index("app.js") < srcs.index("attachments.js")
    assert srcs.index("groups.js") < srcs.index("attachments.js")


def test_files_are_sent_by_the_same_code_as_text():
    assert "async function sendDirectText(" in page("app.js")
    assert "async function sendGroupText(" in page("groups.js")
    text = page("attachments.js")
    assert "sendDirectText(" in text and "sendGroupText(" in text


def test_messages_are_drawn_through_message_body():
    assert "messageBody(m)" in page("app.js")
    assert "function messageBody(" in page("attachments.js")


def test_file_code_never_writes_html():
    # names and types come from other people, they may only ever be put on the page as text
    for name in ("attachments.js", "filecrypto.js"):
        text = page(name)
        for bad in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval("):
            assert bad not in text, (name, bad)


def test_a_download_is_always_saved_as_an_anonymous_file():
    # only pictures, videos and sounds are opened with the type the sender claimed
    assert 'new Blob(parts, { type: "application/octet-stream" })' in page("attachments.js")


def test_the_memory_limit_for_saving_is_one_gigabyte():
    assert js_number("FC_MEM_SAVE_MAX") == 1024 * 1024 * 1024
    assert js_number("FC_MEM_SAVE_MAX") < js_number("FC_MAX_BYTES")


def test_saving_a_file_checks_that_the_browser_can_hold_it():
    code = page("attachments.js")
    save = code[code.index("async function attSave") :]
    check = save.index("fcCanSaveHere(desc.size, window.showSaveFilePicker || ssSupported())")
    assert check < save.index("showSaveFilePicker({")
    assert 'attFail("toobig")' in save[check : check + 200]


def test_big_downloads_can_stream_through_the_service_worker():
    index = page("index.html")
    assert index.index("streamsave.js") < index.index("attachments.js")
    save = page("attachments.js")
    save = save[save.index("async function attSave") :]
    # Chrome and Edge keep the save dialog, the helper is only for browsers without one
    assert save.index("showSaveFilePicker({") < save.index("attStreamSave(desc")
    assert "!window.showSaveFilePicker" in save
    # if the helper isn't there a file that doesn't fit in memory is refused, not loaded into it
    assert 'desc.size > FC_MEM_SAVE_MAX) throw attFail("toobig")' in save


