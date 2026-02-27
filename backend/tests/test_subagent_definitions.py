from unittest.mock import MagicMock
from app.database import Database
from claude_agent_sdk import AgentDefinition


def _make_db(tables=None):
    db = MagicMock(spec=Database)
    db.list_tables.return_value = tables or []
    return db


def test_build_subagent_definitions_returns_two_agents():
    """Should return sql-analyst and chart-builder AgentDefinitions."""
    from app.agent import build_subagent_definitions

    db = _make_db()
    agents = build_subagent_definitions(db)

    assert "sql-analyst" in agents
    assert "chart-builder" in agents
    assert isinstance(agents["sql-analyst"], AgentDefinition)
    assert isinstance(agents["chart-builder"], AgentDefinition)


def test_sql_analyst_has_execute_sql_tool():
    from app.agent import build_subagent_definitions

    db = _make_db()
    agents = build_subagent_definitions(db)

    assert agents["sql-analyst"].tools == ["mcp__duckdb-data-agent__execute_sql"]


def test_chart_builder_has_execute_sql_and_render_chart_tools():
    from app.agent import build_subagent_definitions

    db = _make_db()
    agents = build_subagent_definitions(db)

    assert agents["chart-builder"].tools == ["mcp__duckdb-data-agent__execute_sql", "mcp__duckdb-data-agent__render_chart"]


def test_subagent_prompts_include_table_schemas():
    from app.agent import build_subagent_definitions

    db = _make_db(tables=[{
        "name": "sales",
        "rowCount": 100,
        "columns": [{"name": "id", "type": "INTEGER"}, {"name": "amount", "type": "DOUBLE"}],
    }])
    agents = build_subagent_definitions(db)

    assert '"sales"' in agents["sql-analyst"].prompt
    assert '"id"' in agents["sql-analyst"].prompt
    assert '"sales"' in agents["chart-builder"].prompt


def test_subagent_models_use_sdk_aliases():
    from app.agent import build_subagent_definitions
    from app.config import SQL_SUBAGENT_MODEL_SDK, CHART_SUBAGENT_MODEL_SDK

    db = _make_db()
    agents = build_subagent_definitions(db)

    assert agents["sql-analyst"].model == SQL_SUBAGENT_MODEL_SDK
    assert agents["chart-builder"].model == CHART_SUBAGENT_MODEL_SDK
