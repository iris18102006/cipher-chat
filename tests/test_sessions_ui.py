from pathlib import Path


ROOT = Path(__file__).parents[1]


def test_settings_has_device_management():
    source = (ROOT / "web" / "settings.js").read_text()
    assert 'api("/api/sessions")' in source
    assert 'fetch("/api/sessions/other", { method: "DELETE" })' in source
