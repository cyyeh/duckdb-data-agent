import json
import pytest
from unittest.mock import MagicMock, AsyncMock
from app.tools import create_duckdb_server
from app.database import Database


@pytest.fixture
def db():
    return MagicMock(spec=Database)


@pytest.mark.asyncio
async def test_execute_sql_returns_results(db):
    """execute_sql executes SQL and returns structured results."""
    db.execute_query_async = AsyncMock(return_value={
        "rows": [{"id": 1, "name": "Alice"}, {"id": 2, "name": "Bob"}],
        "columns": ["id", "name"],
        "rowCount": 2,
    })

    server = create_duckdb_server(db)
    execute_sql = next(t for t in server._tools if t.name == "execute_sql")

    result = await execute_sql.handler({"sql": "SELECT * FROM users"})
    content_text = result["content"][0]["text"]
    parsed = json.loads(content_text)

    assert parsed["status"] == "success"
    assert parsed["columns"] == ["id", "name"]
    assert len(parsed["rows"]) == 2


@pytest.mark.asyncio
async def test_execute_sql_error(db):
    """execute_sql returns error on query failure."""
    db.execute_query_async = AsyncMock(side_effect=Exception("syntax error"))

    server = create_duckdb_server(db)
    execute_sql = next(t for t in server._tools if t.name == "execute_sql")

    result = await execute_sql.handler({"sql": "INVALID SQL"})
    content_text = result["content"][0]["text"]
    parsed = json.loads(content_text)

    assert parsed["status"] == "error"
    assert "syntax error" in parsed["error"]


def test_server_has_only_execute_sql_tool(db):
    """Server should only register execute_sql tool (generate_chart removed)."""
    server = create_duckdb_server(db)
    tool_names = [t.name for t in server._tools]
    assert tool_names == ["execute_sql"]
