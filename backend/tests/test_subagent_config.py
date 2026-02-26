from app.config import (
    ANTHROPIC_MODEL, ANTHROPIC_MODEL_SDK,
    SQL_SUBAGENT_MODEL_SDK, CHART_SUBAGENT_MODEL_SDK,
    MODEL_REWRITES,
)


def test_anthropic_model_has_default():
    """ANTHROPIC_MODEL should always have a value."""
    assert ANTHROPIC_MODEL is not None
    assert len(ANTHROPIC_MODEL) > 0


def test_sdk_aliases_are_valid():
    """SDK aliases must be values the Claude Agent SDK accepts."""
    for alias in [ANTHROPIC_MODEL_SDK, SQL_SUBAGENT_MODEL_SDK, CHART_SUBAGENT_MODEL_SDK]:
        assert isinstance(alias, str) and len(alias) > 0


def test_model_rewrites_is_dict():
    assert isinstance(MODEL_REWRITES, dict)
