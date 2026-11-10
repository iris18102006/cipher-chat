import pytest

from backend import main
from tests.test_backend import signup

songs = main.songs  # songs.py can only be imported after main, so reach it through main


def mp3() -> bytes:
    return b"ID3\x03\x00\x00\x00\x00\x00\x00" + bytes(range(256)) * 2


def put(client, data, *, path="/api/me/song"):
    return client.put(path, content=data, headers={"Content-Type": "application/octet-stream"})


@pytest.mark.parametrize(
    "head, mime",
    [
        (b"ID3\x04\x00\x00\x00\x00\x00\x00", "audio/mpeg"),
        (b"\xff\xfb\x90\x64" + b"\x00" * 12, "audio/mpeg"),  # an mp3 with no tag
        (b"OggS\x00\x02" + b"\x00" * 10, "audio/ogg"),
        (b"RIFF\x24\x00\x00\x00WAVEfmt ", "audio/wav"),
        (b"fLaC\x00\x00\x00\x22" + b"\x00" * 8, "audio/flac"),
        (b"\x00\x00\x00\x20ftypM4A " + b"\x00" * 4, "audio/mp4"),
    ],
)
def test_sniff_knows_the_formats(head, mime):
    assert songs.sniff_audio(head + b"\x00" * 100) == mime


@pytest.mark.parametrize(
    "raw",
    [
        b"",
        b"ID3",  # too short to be a real song
        b"%PDF-1.7" + b"\x00" * 100,
        b"\x89PNG\r\n\x1a\n" + b"\x00" * 100,
        b"MZ\x90\x00" + b"\x00" * 100,
        b"<html><script>alert(1)</script></html>" + b" " * 100,
        b"\xff\xe0" + b"\x00" * 100,  # sync bits but no valid layer
        b"RIFF\x24\x00\x00\x00AVI " + b"\x00" * 100,  # riff, but not wave
    ],
)
def test_sniff_says_no_to_everything_else(raw):
    assert songs.sniff_audio(raw) is None


def test_upload_and_play_back(client):
    a = signup(client, "alice")
    r = put(a, mp3())
    assert r.status_code == 200
    url = r.json()["song_url"]
    assert url.startswith("/api/song/")
    got = a.get(url)
    assert got.status_code == 200 and got.content == mp3()
    assert got.headers["content-type"] == "audio/mpeg"
    assert got.headers["x-content-type-options"] == "nosniff"
    assert got.headers["accept-ranges"] == "bytes"
    assert "sandbox" in got.headers["content-security-policy"]


def test_upload_rejects_things_that_are_not_audio(client):
    a = signup(client, "alice")
    assert put(a, b"just some text, not a song at all" * 10).status_code == 400
    assert put(a, b"").status_code == 400
    # the browser's claimed type doesn't matter, only the bytes do
    r = a.put("/api/me/song", content=b"<html></html>" * 20, headers={"Content-Type": "audio/mpeg"})
    assert r.status_code == 400
    assert a.get("/api/profile/alice").json()["song_url"] == ""


def test_upload_size_limit(client, monkeypatch):
    monkeypatch.setattr("backend.main.MAX_SONG_UPLOAD", 1000)
    monkeypatch.setattr("backend.songs.MAX_SONG_UPLOAD", 1000)
    a = signup(client, "alice")
    assert put(a, b"ID3" + b"\x00" * 2000).status_code == 413
    assert put(a, b"ID3" + b"\x00" * 200).status_code == 200


def test_needs_login(client):
    assert put(client, mp3()).status_code == 401
    assert client.get("/api/song/1").status_code == 401
    assert client.delete("/api/me/song").status_code == 401


def test_a_new_upload_replaces_the_old_one_under_a_new_url(client):
    a = signup(client, "alice")
    first = put(a, mp3()).json()["song_url"]
    second = put(a, b"OggS" + b"\x00" * 200).json()["song_url"]
    assert first != second
    assert a.get(first).status_code == 404
    assert a.get(second).headers["content-type"] == "audio/ogg"


def test_profile_shows_the_song_to_other_people(client):
    a = signup(client, "alice")
    b = signup(client, "bob")
    assert b.get("/api/profile/alice").json()["song_url"] == ""
    url = put(a, mp3()).json()["song_url"]
    assert b.get("/api/profile/alice").json()["song_url"] == url
    assert b.get(url).content == mp3()


def test_remove_song(client):
    a = signup(client, "alice")
    url = put(a, mp3()).json()["song_url"]
    assert a.delete("/api/me/song").json() == {"song_url": ""}
    assert a.get(url).status_code == 404
    assert a.get("/api/profile/alice").json()["song_url"] == ""
    # removing when there's none is fine
    assert a.delete("/api/me/song").status_code == 200


def test_someone_who_blocked_you_does_not_let_you_listen(client):
    a = signup(client, "alice")
    b = signup(client, "bob")
    url = put(a, mp3()).json()["song_url"]
    assert b.get(url).status_code == 200
    assert a.post("/api/blocks/bob").status_code == 200
    assert b.get(url).status_code == 404
    assert a.get(url).status_code == 200  # your own, always


def test_byte_ranges(client):
    a = signup(client, "alice")
    data = mp3()
    url = put(a, data).json()["song_url"]
    r = a.get(url, headers={"Range": "bytes=10-19"})
    assert r.status_code == 206 and r.content == data[10:20]
    assert r.headers["content-range"] == f"bytes 10-19/{len(data)}"
    r = a.get(url, headers={"Range": "bytes=500-"})
    assert r.status_code == 206 and r.content == data[500:]
    r = a.get(url, headers={"Range": "bytes=-20"})
    assert r.status_code == 206 and r.content == data[-20:]
    # asking past the end is clipped
    r = a.get(url, headers={"Range": f"bytes=500-{len(data) + 999}"})
    assert r.content == data[500:]


def test_bad_ranges(client):
    a = signup(client, "alice")
    data = mp3()
    url = put(a, data).json()["song_url"]
    assert a.get(url, headers={"Range": f"bytes={len(data)}-"}).status_code == 416
    assert a.get(url, headers={"Range": "bytes=9-3"}).status_code == 416
    # things we don't do just get the whole song
    for odd in ("bytes=0-1,5-6", "lines=1-2", "bytes=abc-", "bytes=-0", "bytes=-"):
        r = a.get(url, headers={"Range": odd})
        assert r.status_code == 200 and r.content == data, odd
