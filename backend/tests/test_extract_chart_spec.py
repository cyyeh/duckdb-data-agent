"""Tests for _extract_chart_spec helper."""

from app.agent import _extract_chart_spec


def test_pure_json_with_chart_spec():
    text = '{"chart_spec": {"data": [{"x": [1], "y": [2], "type": "bar"}], "layout": {"title": "Test"}}}'
    result = _extract_chart_spec(text)
    assert result is not None
    assert result["data"][0]["type"] == "bar"
    assert result["layout"]["title"] == "Test"


def test_markdown_fenced_json_block():
    text = (
        "Here is the chart:\n\n"
        "```json\n"
        '{"chart_spec": {"data": [{"x": [1, 2], "y": [3, 4], "type": "scatter"}], "layout": {"title": "Scatter"}}}\n'
        "```\n\n"
        "This shows the data trend."
    )
    result = _extract_chart_spec(text)
    assert result is not None
    assert result["data"][0]["type"] == "scatter"
    assert result["layout"]["title"] == "Scatter"


def test_markdown_fenced_block_without_json_tag():
    text = (
        "```\n"
        '{"chart_spec": {"data": [{"type": "pie", "labels": ["A"], "values": [1]}], "layout": {}}}\n'
        "```"
    )
    result = _extract_chart_spec(text)
    assert result is not None
    assert result["data"][0]["type"] == "pie"


def test_bare_chart_spec_data_and_layout():
    """When the fenced block contains data+layout directly (no chart_spec wrapper)."""
    text = (
        "```json\n"
        '{"data": [{"x": [1], "y": [2], "type": "line"}], "layout": {"title": "Direct"}}\n'
        "```"
    )
    result = _extract_chart_spec(text)
    assert result is not None
    assert result["data"][0]["type"] == "line"


def test_no_chart_spec_returns_none():
    result = _extract_chart_spec("Just some plain text without any JSON.")
    assert result is None


def test_invalid_json_returns_none():
    result = _extract_chart_spec("```json\n{invalid json}\n```")
    assert result is None


def test_json_without_chart_spec_key_returns_none():
    text = '{"status": "success", "rows": [1, 2, 3]}'
    result = _extract_chart_spec(text)
    assert result is None


def test_empty_string_returns_none():
    assert _extract_chart_spec("") is None
