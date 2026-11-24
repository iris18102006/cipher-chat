from pathlib import Path


ROOT = Path(__file__).parents[1]


def test_feed_composer_is_only_visible_on_everyone_tab():
    source = (ROOT / "web" / "feed.js").read_text()
    assert 'feed.tab === "all"' in source and "feed-compose-box" in source


def test_feed_tabs_use_line_icons_and_gif_picker_uses_post_media():
    feed = (ROOT / "web" / "feed.js").read_text()
    compose = (ROOT / "web" / "feed-compose.js").read_text()
    gifs = (ROOT / "web" / "gifs.js").read_text()
    assert 'tabIcons = { all: "users", close: "star", mine: "file" }' in feed
    assert 'openGifsForPost(addGifFile)' in compose
    assert 'if (postPick) await postPick(file);' in gifs
    assert 'xhr.open("POST", "/api/post-media")' in compose
