from app.agent import build_system_prompt
from unittest.mock import MagicMock
from app.database import Database


def test_build_system_prompt_delegates_to_subagents():
    """System prompt should instruct orchestrator to use subagents, not tools directly."""
    db = MagicMock(spec=Database)
    db.list_tables.return_value = []
    prompt = build_system_prompt(db)
    assert "sql-analyst" in prompt
    assert "chart-builder" in prompt
    # Should NOT mention execute_sql or generate_chart tools directly
    assert "execute_sql" not in prompt
    assert "generate_chart" not in prompt
