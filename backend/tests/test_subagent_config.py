from app.config import ANTHROPIC_MODEL


def test_anthropic_model_has_default():
    """ANTHROPIC_MODEL should always have a value."""
    assert ANTHROPIC_MODEL is not None
    assert len(ANTHROPIC_MODEL) > 0
