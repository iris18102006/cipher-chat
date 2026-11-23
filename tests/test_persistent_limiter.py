from backend import db
from backend.security import PersistentLimiter


def test_persistent_limiter_survives_new_instance(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "rate.db")
    db.init_db()
    first = PersistentLimiter("test", 2, 60)
    first.hit("alice")
    second = PersistentLimiter("test", 2, 60)
    assert not second.blocked("alice")
    second.hit("alice")
    assert second.blocked("alice")


def test_persistent_limiter_clear_is_namespace_scoped(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "rate.db")
    db.init_db()
    one = PersistentLimiter("one", 1, 60)
    two = PersistentLimiter("two", 1, 60)
    one.hit("same-key")
    two.hit("same-key")
    one.clear()
    assert not one.blocked("same-key")
    assert two.blocked("same-key")
