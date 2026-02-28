from app.config import (
    ORCHESTRATOR_MODEL_SDK,
    SQL_SUBAGENT_MODEL_SDK,
    MODEL_REWRITES,
)


def test_orchestrator_model_has_default():
    """ORCHESTRATOR_MODEL_SDK should always have a value."""
    assert ORCHESTRATOR_MODEL_SDK is not None
    assert len(ORCHESTRATOR_MODEL_SDK) > 0


def test_sdk_aliases_are_valid():
    """SDK aliases must be values the Claude Agent SDK accepts."""
    for alias in [ORCHESTRATOR_MODEL_SDK, SQL_SUBAGENT_MODEL_SDK]:
        assert isinstance(alias, str) and len(alias) > 0


def test_model_rewrites_is_dict():
    assert isinstance(MODEL_REWRITES, dict)
