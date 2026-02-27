def test_parse_model_with_at_suffix():
    from app.config import parse_model
    sdk, real = parse_model("openai/gpt-4o@sonnet")
    assert sdk == "sonnet"
    assert real == "openai/gpt-4o"


def test_parse_model_without_suffix():
    from app.config import parse_model
    sdk, real = parse_model("haiku")
    assert sdk == "haiku"
    assert real == "haiku"


def test_parse_model_full_anthropic_name():
    from app.config import parse_model
    sdk, real = parse_model("claude-sonnet-4-6")
    assert sdk == "claude-sonnet-4-6"
    assert real == "claude-sonnet-4-6"


def test_parse_model_empty_string():
    from app.config import parse_model
    sdk, real = parse_model("")
    assert sdk == ""
    assert real == ""


def test_build_model_rewrites_with_suffix():
    from app.config import build_model_rewrites
    rewrites = build_model_rewrites([
        ("sonnet", "openai/gpt-4o"),
        ("haiku", "openai/gpt-4o-mini"),
    ])
    assert rewrites == {"sonnet": "openai/gpt-4o", "haiku": "openai/gpt-4o-mini"}


def test_build_model_rewrites_skips_same():
    from app.config import build_model_rewrites
    rewrites = build_model_rewrites([
        ("haiku", "haiku"),
        ("sonnet", "openai/gpt-4o"),
    ])
    assert rewrites == {"sonnet": "openai/gpt-4o"}


def test_build_model_rewrites_empty():
    from app.config import build_model_rewrites
    rewrites = build_model_rewrites([("haiku", "haiku")])
    assert rewrites == {}
