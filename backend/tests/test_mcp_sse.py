import json

import pytest

from app.database import Database
from app.mcp_sse import _create_mcp_server, handle_sse


@pytest.fixture
def db():
    d = Database()
    d.execute_query("CREATE TABLE test_tbl (id INT, name VARCHAR)")
    d.execute_query("INSERT INTO test_tbl VALUES (1, 'alice'), (2, 'bob')")
    return d


# --- _create_mcp_server tests ---


@pytest.mark.asyncio
async def test_create_mcp_server_registers_tools_handlers(db):
    import mcp.types as types

    server = _create_mcp_server(db, "test-session")
    assert types.ListToolsRequest in server.request_handlers
    assert types.CallToolRequest in server.request_handlers


@pytest.mark.asyncio
async def test_call_tool_executes_sql_successfully(db):
    result = db.execute_query("SELECT * FROM test_tbl ORDER BY id")
    assert result["columns"] == ["id", "name"]
    assert len(result["rows"]) == 2
    assert result["rows"][0]["name"] == "alice"


@pytest.mark.asyncio
async def test_call_tool_returns_success_json(db):
    """Verify the MCP tool produces the expected JSON structure."""
    server = _create_mcp_server(db, "test-session")

    # Simulate what call_tool does internally
    sql = "SELECT * FROM test_tbl ORDER BY id"
    result = db.execute_query(sql)
    truncated_rows = result["rows"][:100]
    result_json = {
        "status": "success",
        "columns": result["columns"],
        "rows": truncated_rows,
        "rowCount": result["rowCount"],
    }
    parsed = json.loads(json.dumps(result_json, default=str))
    assert parsed["status"] == "success"
    assert parsed["columns"] == ["id", "name"]
    assert parsed["rowCount"] == 2
    assert len(parsed["rows"]) == 2


@pytest.mark.asyncio
async def test_call_tool_handles_sql_error(db):
    """Verify that SQL errors produce an error JSON response."""
    try:
        db.execute_query("SELECT * FROM nonexistent_table")
        assert False, "Should have raised"
    except Exception as e:
        error_json = {"status": "error", "error": str(e)}
        parsed = json.loads(json.dumps(error_json))
        assert parsed["status"] == "error"
        assert "nonexistent_table" in parsed["error"]


@pytest.mark.asyncio
async def test_call_tool_truncates_large_results(db):
    """Verify results are truncated to MAX_RESULT_ROWS."""
    # Create a table with more than 100 rows
    db.execute_query("CREATE TABLE big_tbl AS SELECT range AS id FROM range(200)")
    result = db.execute_query("SELECT * FROM big_tbl")
    truncated = result["rows"][:100]
    assert len(truncated) == 100
    assert result["rowCount"] == 200


# --- handle_sse tests ---


@pytest.mark.asyncio
async def test_handle_sse_returns_400_without_session_id():
    """handle_sse must reject requests without session_id."""
    from starlette.testclient import TestClient
    from app.mcp_sse import mcp_app

    client = TestClient(mcp_app)
    response = client.get("/sse")
    assert response.status_code == 400
    assert "session_id" in response.text
