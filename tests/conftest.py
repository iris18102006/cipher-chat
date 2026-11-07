import pytest
from fastapi.testclient import TestClient

from backend import db


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.db")
    db.init_db()
    from backend import main

    main._fails.clear()
    main.manager.sockets.clear()
    with TestClient(main.app) as c:
        yield c
