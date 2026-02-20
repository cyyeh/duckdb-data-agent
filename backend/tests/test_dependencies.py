from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from app.dependencies import get_session_db
from app.session_manager import session_manager


def make_app():
    app = FastAPI()

    @app.get("/test-dep")
    async def test_route(db=Depends(get_session_db)):
        return {"tables": db.list_tables()}

    return app


def test_missing_session_header_returns_422():
    client = TestClient(make_app(), raise_server_exceptions=False)
    response = client.get("/test-dep")
    assert response.status_code == 422  # FastAPI returns 422 for missing required header


def test_valid_session_header_returns_200():
    client = TestClient(make_app())
    response = client.get("/test-dep", headers={"X-Session-ID": "test-uuid"})
    assert response.status_code == 200
    assert response.json() == {"tables": []}


def test_two_different_sessions_are_isolated():
    # Manually create two sessions
    db1 = session_manager.get_or_create("session-a")
    db2 = session_manager.get_or_create("session-b")
    db1.execute_query("CREATE TABLE only_in_a (x INT)")

    tables_a = [t["name"] for t in db1.list_tables()]
    tables_b = [t["name"] for t in db2.list_tables()]
    assert "only_in_a" in tables_a
    assert "only_in_a" not in tables_b

    # Cleanup
    session_manager.destroy("session-a")
    session_manager.destroy("session-b")
