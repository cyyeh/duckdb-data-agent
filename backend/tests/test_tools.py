import json
import pytest
from unittest.mock import MagicMock
from app.tools import create_duckdb_server
from app.database import Database


@pytest.fixture
def db():
    return MagicMock(spec=Database)


@pytest.mark.asyncio
async def test_generate_chart_returns_chart_spec(db):
    """generate_chart executes SQL and returns a chart_spec with actual data."""
    from unittest.mock import AsyncMock
    db.execute_query_async = AsyncMock(return_value={
        "rows": [{"category": "A", "value": 1}, {"category": "B", "value": 2}],
        "columns": ["category", "value"],
        "rowCount": 2,
    })

    server = create_duckdb_server(db)
    generate_chart = next(t for t in server._tools if t.name == "generate_chart")

    args = {
        "sql": "SELECT category, value FROM t",
        "chart_type": "bar",
        "x_col": "category",
        "y_col": "value",
        "title": "Test Chart",
    }
    result = await generate_chart.handler(args)
    content_text = result["content"][0]["text"]
    parsed = json.loads(content_text)

    assert parsed["status"] == "success"
    assert parsed["chart_spec"]["data"][0]["x"] == ["A", "B"]
    assert parsed["chart_spec"]["data"][0]["y"] == [1, 2]
    assert parsed["chart_spec"]["layout"]["title"] == "Test Chart"


@pytest.mark.asyncio
async def test_generate_chart_missing_sql_returns_error(db):
    """generate_chart returns an error when sql is missing."""
    server = create_duckdb_server(db)
    generate_chart = next(t for t in server._tools if t.name == "generate_chart")

    result = await generate_chart.handler({"chart_type": "bar", "x_col": "a", "y_col": "b"})
    content_text = result["content"][0]["text"]
    parsed = json.loads(content_text)

    assert parsed["status"] == "error"
    assert "sql" in parsed["error"]


@pytest.mark.asyncio
async def test_generate_chart_title_is_optional(db):
    """generate_chart works without a title argument."""
    from unittest.mock import AsyncMock
    db.execute_query_async = AsyncMock(return_value={
        "rows": [{"label": "X", "val": 10}, {"label": "Y", "val": 20}],
        "columns": ["label", "val"],
        "rowCount": 2,
    })

    server = create_duckdb_server(db)
    generate_chart = next(t for t in server._tools if t.name == "generate_chart")

    args = {"sql": "SELECT label, val FROM t", "chart_type": "pie", "x_col": "label", "y_col": "val"}
    result = await generate_chart.handler(args)
    content_text = result["content"][0]["text"]
    parsed = json.loads(content_text)

    assert parsed["status"] == "success"
    assert parsed["chart_spec"]["layout"] == {}
