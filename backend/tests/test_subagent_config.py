from app.config import SQL_SUBAGENT_MODEL, CHART_SUBAGENT_MODEL


def test_subagent_model_defaults():
    """Subagent model configs should have sensible defaults."""
    assert SQL_SUBAGENT_MODEL in ("haiku", "sonnet", "opus", "inherit")
    assert CHART_SUBAGENT_MODEL in ("haiku", "sonnet", "opus", "inherit")
