from unittest.mock import MagicMock
from app.agent import build_subagent_definitions, build_system_prompt
from app.database import Database


def test_build_system_prompt_delegates_to_subagents():
    """System prompt should instruct orchestrator to use subagents, not tools directly."""
    db = MagicMock(spec=Database)
    db.list_tables.return_value = []
    prompt = build_system_prompt(db)
    assert "sql-analyst" in prompt
    assert "chart-builder" in prompt
    assert "execute_sql" not in prompt
    assert "generate_chart" not in prompt


def test_chart_builder_prompt_instructs_render_chart_tool():
    """Chart-builder prompt must tell the LLM to call render_chart, not output a code block."""
    db = MagicMock(spec=Database)
    db.list_tables.return_value = []
    defs = build_subagent_definitions(db)
    prompt = defs["chart-builder"].prompt
    assert "render_chart" in prompt
    assert "```json" not in prompt  # no code block instruction


def test_chart_builder_tools_include_render_chart():
    """Chart-builder AgentDefinition must include render_chart in its tools list."""
    db = MagicMock(spec=Database)
    db.list_tables.return_value = []
    defs = build_subagent_definitions(db)
    tools = defs["chart-builder"].tools
    assert any("render_chart" in t for t in tools)
