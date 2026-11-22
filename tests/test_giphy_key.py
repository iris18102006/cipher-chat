"""Where the GIPHY key comes from: the environment, or a giphy.key file next to server.py."""
from backend import main  # noqa: F401  (main has to be imported first, the other modules import it)
from backend import gifs


def test_no_key_means_search_is_off(monkeypatch, tmp_path):
    monkeypatch.delenv("CIPHER_GIPHY_KEY", raising=False)
    monkeypatch.setattr(gifs, "KEY_FILE", tmp_path / "giphy.key")
    assert gifs.api_key() == ""


def test_key_from_the_environment(monkeypatch, tmp_path):
    monkeypatch.setattr(gifs, "KEY_FILE", tmp_path / "giphy.key")
    monkeypatch.setenv("CIPHER_GIPHY_KEY", "  abcDEF123456  ")
    assert gifs.api_key() == "abcDEF123456"


def test_key_from_the_file_first_line_only(monkeypatch, tmp_path):
    monkeypatch.delenv("CIPHER_GIPHY_KEY", raising=False)
    f = tmp_path / "giphy.key"
    f.write_text("fileKEY1234567890\nthis line is ignored\n")
    monkeypatch.setattr(gifs, "KEY_FILE", f)
    assert gifs.api_key() == "fileKEY1234567890"


def test_environment_wins_over_the_file(monkeypatch, tmp_path):
    f = tmp_path / "giphy.key"
    f.write_text("fileKEY1234567890")
    monkeypatch.setattr(gifs, "KEY_FILE", f)
    monkeypatch.setenv("CIPHER_GIPHY_KEY", "envKEY1234567890")
    assert gifs.api_key() == "envKEY1234567890"


def test_a_key_that_looks_wrong_is_ignored(monkeypatch, tmp_path):
    monkeypatch.delenv("CIPHER_GIPHY_KEY", raising=False)
    f = tmp_path / "giphy.key"
    f.write_text("my key is: abc&other=1")
    monkeypatch.setattr(gifs, "KEY_FILE", f)
    assert gifs.api_key() == ""
