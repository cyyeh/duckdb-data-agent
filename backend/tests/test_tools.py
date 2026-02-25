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

    server = create_duckdb_server(db, "test-session")
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

    server = create_duckdb_server(db, "test-session")
    execute_sql = next(t for t in server._tools if t.name == "execute_sql")

    result = await execute_sql.handler({"sql": "INVALID SQL"})
    content_text = result["content"][0]["text"]
    parsed = json.loads(content_text)

    assert parsed["status"] == "error"
    assert "syntax error" in parsed["error"]


def test_server_has_expected_tools(db):
    """Server should register execute_sql and ask_user_question tools."""
    server = create_duckdb_server(db, "test-session")
    tool_names = [t.name for t in server._tools]
    assert "execute_sql" in tool_names
    assert "ask_user_question" in tool_names
    assert len(tool_names) == 2


@pytest.mark.asyncio
async def test_ask_user_question_tool_exists(db):
    """Server registers ask_user_question tool."""
    server = create_duckdb_server(db, "test-session")
    tool_names = [t.name for t in server._tools]
    assert "ask_user_question" in tool_names


@pytest.mark.asyncio
async def test_ask_user_question_stores_and_waits(db):
    """ask_user_question stores question and returns answer after respond()."""
    from app.pending_questions import pending_question_store
    import asyncio

    server = create_duckdb_server(db, "test-session-aq")
    ask_tool = next(t for t in server._tools if t.name == "ask_user_question")

    async def respond_later():
        await asyncio.sleep(0.05)
        pending = pending_question_store.get_pending("test-session-aq")
        assert pending is not None
        pending_question_store.respond("test-session-aq", pending["question_id"], {"answers": ["Bar chart"]})

    asyncio.create_task(respond_later())
    result = await ask_tool.handler({
        "question": "Which chart?",
        "options": [{"label": "Bar chart"}, {"label": "Line chart"}],
        "multi_select": False,
    })
    content_text = result["content"][0]["text"]
    parsed = json.loads(content_text)
    assert parsed["answers"] == ["Bar chart"]


@pytest.mark.asyncio
async def test_ask_user_question_timeout(db):
    """ask_user_question returns timeout result when no response."""
    server = create_duckdb_server(db, "test-session-timeout")
    ask_tool = next(t for t in server._tools if t.name == "ask_user_question")

    result = await ask_tool.handler({
        "question": "Which chart?",
        "options": [{"label": "A"}],
        "timeout": 0.1,
    })
    content_text = result["content"][0]["text"]
    parsed = json.loads(content_text)
    assert parsed["timeout"] is True
