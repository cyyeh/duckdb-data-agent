import json
from app.agent import build_system_prompt
from unittest.mock import MagicMock
from app.database import Database


def test_build_system_prompt_mentions_generate_chart():
    """System prompt must instruct the agent about chart generation."""
    db = MagicMock(spec=Database)
    db.list_tables.return_value = []
    prompt = build_system_prompt(db)
    assert "generate_chart" in prompt
    assert "chart" in prompt.lower()
