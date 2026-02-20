from app.session_manager import SessionManager


def test_get_or_create_returns_database():
    mgr = SessionManager()
    db = mgr.get_or_create("abc")
    assert db is not None


def test_same_session_id_returns_same_instance():
    mgr = SessionManager()
    db1 = mgr.get_or_create("abc")
    db2 = mgr.get_or_create("abc")
    assert db1 is db2


def test_different_session_ids_return_different_instances():
    mgr = SessionManager()
    db1 = mgr.get_or_create("abc")
    db2 = mgr.get_or_create("xyz")
    assert db1 is not db2


def test_different_sessions_are_isolated():
    mgr = SessionManager()
    db1 = mgr.get_or_create("user1")
    db2 = mgr.get_or_create("user2")
    db1.execute_query("CREATE TABLE t1 (x INT)")
    tables1 = [t["name"] for t in db1.list_tables()]
    tables2 = [t["name"] for t in db2.list_tables()]
    assert "t1" in tables1
    assert "t1" not in tables2


def test_touch_returns_true_for_existing_session():
    mgr = SessionManager()
    mgr.get_or_create("abc")
    assert mgr.touch("abc") is True


def test_touch_returns_false_for_unknown_session():
    mgr = SessionManager()
    assert mgr.touch("unknown") is False


def test_destroy_removes_session():
    mgr = SessionManager()
    mgr.get_or_create("abc")
    mgr.destroy("abc")
    # After destroy, get_or_create creates a fresh instance
    db_new = mgr.get_or_create("abc")
    assert db_new.list_tables() == []


def test_cleanup_stale_removes_old_sessions():
    mgr = SessionManager()
    mgr.get_or_create("old")
    # Manually backdate last_seen_at
    from datetime import datetime, timedelta, timezone
    mgr._sessions["old"].last_seen_at = datetime.now(timezone.utc) - timedelta(seconds=400)
    removed = mgr.cleanup_stale(ttl_seconds=300)
    assert removed == 1
    assert "old" not in mgr._sessions


def test_cleanup_stale_keeps_recent_sessions():
    mgr = SessionManager()
    mgr.get_or_create("recent")
    removed = mgr.cleanup_stale(ttl_seconds=300)
    assert removed == 0
    assert "recent" in mgr._sessions
