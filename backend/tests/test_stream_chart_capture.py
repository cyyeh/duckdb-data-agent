"""Tests for render_chart tool_use capture in stream_chat message handling."""
from app.agent import _build_chart_spec_from_stream_messages


def _make_assistant_msg(parent_tool_use_id, tool_use_name, tool_input):
    """Helper: build a minimal SDK 'assistant' message dict."""
    return {
        "type": "assistant",
        "parent_tool_use_id": parent_tool_use_id,
        "message": {
            "content": [
                {
                    "type": "tool_use",
                    "id": "tu_render_1",
                    "name": tool_use_name,
                    "input": tool_input,
                }
            ]
        },
    }


def test_captures_render_chart_input_as_chart_spec():
    """render_chart tool_use.input is captured as chart_spec for the parent task id."""
    chart_input = {
        "data": [{"type": "bar", "x": ["A", "B"], "y": [1, 2]}],
        "layout": {"title": "Sales by Category"},
    }
    msg = _make_assistant_msg(
        parent_tool_use_id="task_001",
        tool_use_name="mcp__duckdb-data-agent__render_chart",
        tool_input=chart_input,
    )

    specs: dict = {}
    tool_names = {"task_001": "chart-builder"}
    _build_chart_spec_from_stream_messages(msg, tool_names, specs)

    assert specs["task_001"] == chart_input


def test_ignores_non_render_chart_tool_use():
    """Other tool_use blocks in a chart-builder turn are not captured as chart_spec."""
    msg = _make_assistant_msg(
        parent_tool_use_id="task_001",
        tool_use_name="mcp__duckdb-data-agent__execute_sql",
        tool_input={"sql": "SELECT 1"},
    )

    specs: dict = {}
    tool_names = {"task_001": "chart-builder"}
    _build_chart_spec_from_stream_messages(msg, tool_names, specs)

    assert specs == {}


def test_ignores_messages_not_from_chart_builder():
    """Tool_use blocks from non-chart-builder subagents are ignored."""
    msg = _make_assistant_msg(
        parent_tool_use_id="task_002",
        tool_use_name="mcp__duckdb-data-agent__render_chart",
        tool_input={"data": [], "layout": {"title": "x"}},
    )

    specs: dict = {}
    tool_names = {"task_002": "sql-analyst"}  # not chart-builder
    _build_chart_spec_from_stream_messages(msg, tool_names, specs)

    assert specs == {}
