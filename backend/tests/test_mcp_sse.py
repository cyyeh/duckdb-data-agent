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
    """execute_sql tool returns correct columns and rows via the MCP handler."""
    import mcp.types as types

    server = _create_mcp_server(db, "test-session")
    handler = server.request_handlers[types.CallToolRequest]
    request = types.CallToolRequest(
        method="tools/call",
        params=types.CallToolRequestParams(
            name="execute_sql",
            arguments={"sql": "SELECT * FROM test_tbl ORDER BY id"},
        ),
    )
    result = await handler(request)
    content = result.root.content[0]
    parsed = json.loads(content.text)
    assert parsed["status"] == "success"
    assert parsed["columns"] == ["id", "name"]
    assert len(parsed["rows"]) == 2
    assert parsed["rows"][0]["name"] == "alice"


@pytest.mark.asyncio
async def test_call_tool_returns_success_json(db):
    """execute_sql tool response has status, columns, rows, and rowCount fields."""
    import mcp.types as types

    server = _create_mcp_server(db, "test-session")
    handler = server.request_handlers[types.CallToolRequest]
    request = types.CallToolRequest(
        method="tools/call",
        params=types.CallToolRequestParams(
            name="execute_sql",
            arguments={"sql": "SELECT * FROM test_tbl ORDER BY id"},
        ),
    )
    result = await handler(request)
    content = result.root.content[0]
    parsed = json.loads(content.text)
    assert parsed["status"] == "success"
    assert "columns" in parsed
    assert "rows" in parsed
    assert "rowCount" in parsed
    assert parsed["rowCount"] == 2


@pytest.mark.asyncio
async def test_call_tool_handles_sql_error(db):
    """execute_sql tool returns error JSON for invalid SQL via the MCP handler."""
    import mcp.types as types

    server = _create_mcp_server(db, "test-session")
    handler = server.request_handlers[types.CallToolRequest]
    request = types.CallToolRequest(
        method="tools/call",
        params=types.CallToolRequestParams(
            name="execute_sql",
            arguments={"sql": "SELECT * FROM nonexistent_table"},
        ),
    )
    result = await handler(request)
    content = result.root.content[0]
    parsed = json.loads(content.text)
    assert parsed["status"] == "error"
    assert "nonexistent_table" in parsed["error"]


@pytest.mark.asyncio
async def test_call_tool_truncates_large_results(db):
    """execute_sql tool truncates results to MAX_RESULT_ROWS via the MCP handler."""
    import mcp.types as types
    from app.mcp_sse import MAX_RESULT_ROWS

    db.execute_query("CREATE TABLE big_tbl AS SELECT range AS id FROM range(200)")
    server = _create_mcp_server(db, "test-session")
    handler = server.request_handlers[types.CallToolRequest]
    request = types.CallToolRequest(
        method="tools/call",
        params=types.CallToolRequestParams(
            name="execute_sql",
            arguments={"sql": "SELECT * FROM big_tbl"},
        ),
    )
    result = await handler(request)
    content = result.root.content[0]
    parsed = json.loads(content.text)
    assert parsed["status"] == "success"
    assert len(parsed["rows"]) == MAX_RESULT_ROWS
    assert parsed["rowCount"] == 200


@pytest.mark.asyncio
async def test_list_tools_includes_render_chart(db):
    """render_chart must appear in the MCP tool list."""
    import mcp.types as types

    server = _create_mcp_server(db, "test-session")
    handler = server.request_handlers[types.ListToolsRequest]
    result = await handler(types.ListToolsRequest(method="tools/list"))
    tool_names = [t.name for t in result.root.tools]
    assert "render_chart" in tool_names


@pytest.mark.asyncio
async def test_render_chart_schema_requires_title(db):
    """render_chart inputSchema must require layout.title."""
    import mcp.types as types

    server = _create_mcp_server(db, "test-session")
    handler = server.request_handlers[types.ListToolsRequest]
    result = await handler(types.ListToolsRequest(method="tools/list"))
    tool = next(t for t in result.root.tools if t.name == "render_chart")
    schema = tool.inputSchema
    assert "layout" in schema["required"]
    assert "title" in schema["properties"]["layout"]["required"]


@pytest.mark.asyncio
async def test_call_render_chart_returns_rendered(db):
    """Calling render_chart returns status=success with chart_spec."""
    import mcp.types as types

    server = _create_mcp_server(db, "test-session")
    handler = server.request_handlers[types.CallToolRequest]
    request = types.CallToolRequest(
        method="tools/call",
        params=types.CallToolRequestParams(
            name="render_chart",
            arguments={
                "data": [{"type": "bar", "x": ["A"], "y": [1]}],
                "layout": {"title": "My Chart"},
            },
        ),
    )
    result = await handler(request)
    content = result.root.content[0]
    assert content.type == "text"
    parsed = json.loads(content.text)
    assert parsed["status"] == "success"
    assert "chart_spec" in parsed
    assert parsed["chart_spec"]["data"] == [{"type": "bar", "x": ["A"], "y": [1]}]
    assert parsed["chart_spec"]["layout"]["title"] == "My Chart"


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
