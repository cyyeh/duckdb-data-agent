import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.session_manager import session_manager


@pytest.fixture(autouse=True)
def clean_sessions():
    """Clear all sessions before and after each test."""
    session_manager._sessions.clear()
    yield
    session_manager._sessions.clear()


client = TestClient(app)


def test_heartbeat_updates_existing_session():
    # First create a session via the tables endpoint
    r = client.get("/api/tables", headers={"X-Session-ID": "hb-test"})
    assert r.status_code == 200

    from datetime import datetime, timedelta, timezone
    # Backdate last_seen_at to simulate time passing
    session_manager._sessions["hb-test"].last_seen_at = datetime.now(timezone.utc) - timedelta(seconds=200)
    old_time = session_manager._sessions["hb-test"].last_seen_at

    r2 = client.post("/api/heartbeat", headers={"X-Session-ID": "hb-test"})
    assert r2.status_code == 200
    assert session_manager._sessions["hb-test"].last_seen_at > old_time


def test_heartbeat_unknown_session_returns_404():
    r = client.post("/api/heartbeat", headers={"X-Session-ID": "nonexistent"})
    assert r.status_code == 404


def test_cleanup_destroys_session():
    # Create session
    client.get("/api/tables", headers={"X-Session-ID": "cleanup-test"})
    assert "cleanup-test" in session_manager._sessions

    r = client.post("/api/session/cleanup?session_id=cleanup-test")
    assert r.status_code == 200
    assert "cleanup-test" not in session_manager._sessions


def test_cleanup_unknown_session_returns_200():
    r = client.post("/api/session/cleanup?session_id=does-not-exist")
    assert r.status_code == 200
