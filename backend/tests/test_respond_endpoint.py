import pytest
from fastapi.testclient import TestClient
from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


def test_respond_endpoint_resolves_pending_question(client):
    """POST /api/chat/respond sets the answer on the pending question store."""
    from app.pending_questions import pending_question_store

    qid = pending_question_store.create("test-respond-session", {
        "question": "Pick one",
        "options": [{"label": "A"}],
    })

    response = client.post(
        "/api/chat/respond",
        json={"question_id": qid, "answers": ["A"]},
        headers={"X-Session-ID": "test-respond-session"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_respond_endpoint_missing_session_id(client):
    """POST /api/chat/respond without X-Session-ID returns 422."""
    response = client.post(
        "/api/chat/respond",
        json={"question_id": "abc", "answers": ["A"]},
    )
    assert response.status_code == 422


def test_respond_endpoint_unknown_question(client):
    """POST /api/chat/respond with unknown question_id returns 404."""
    response = client.post(
        "/api/chat/respond",
        json={"question_id": "nonexistent", "answers": ["A"]},
        headers={"X-Session-ID": "no-such-session"},
    )
    assert response.status_code == 404
