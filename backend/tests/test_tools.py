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
    """generate_chart echoes a valid Plotly spec back as chart_spec."""
    server = create_duckdb_server(db)
    # Find the generate_chart tool handler
    generate_chart = next(t for t in server._tools if t.name == "generate_chart")

    args = {
        "data": [{"type": "bar", "x": ["A", "B"], "y": [1, 2]}],
        "layout": {"title": "Test Chart"},
    }
    result = await generate_chart.handler(args)
    content_text = result["content"][0]["text"]
    parsed = json.loads(content_text)

    assert parsed["status"] == "success"
    assert parsed["chart_spec"]["data"] == args["data"]
    assert parsed["chart_spec"]["layout"] == args["layout"]


@pytest.mark.asyncio
async def test_generate_chart_missing_data_returns_error(db):
    """generate_chart returns an error when data is missing."""
    server = create_duckdb_server(db)
    generate_chart = next(t for t in server._tools if t.name == "generate_chart")

    result = await generate_chart.handler({"layout": {"title": "No data"}})
    content_text = result["content"][0]["text"]
    parsed = json.loads(content_text)

    assert parsed["status"] == "error"
    assert "data" in parsed["error"]


@pytest.mark.asyncio
async def test_generate_chart_layout_is_optional(db):
    """generate_chart works without a layout argument."""
    server = create_duckdb_server(db)
    generate_chart = next(t for t in server._tools if t.name == "generate_chart")

    args = {"data": [{"type": "pie", "labels": ["X", "Y"], "values": [10, 20]}]}
    result = await generate_chart.handler(args)
    content_text = result["content"][0]["text"]
    parsed = json.loads(content_text)

    assert parsed["status"] == "success"
    assert parsed["chart_spec"]["layout"] == {}
