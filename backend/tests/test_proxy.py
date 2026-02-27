import json
from app.config import parse_model
from app.proxy import rewrite_model_in_body


def test_rewrite_model_matching_tier():
    rewrites = {"sonnet": "openai/gpt-4o"}
    body = json.dumps({"model": "claude-sonnet-4-6", "messages": []}).encode()
    result = rewrite_model_in_body(body, rewrites)
    parsed = json.loads(result)
    assert parsed["model"] == "openai/gpt-4o"


def test_rewrite_model_haiku_full_name():
    rewrites = {"haiku": "openai/gpt-4o-mini"}
    body = json.dumps({"model": "claude-haiku-4-5-20251001", "messages": []}).encode()
    result = rewrite_model_in_body(body, rewrites)
    parsed = json.loads(result)
    assert parsed["model"] == "openai/gpt-4o-mini"


def test_rewrite_model_no_match():
    rewrites = {"sonnet": "openai/gpt-4o"}
    body = json.dumps({"model": "claude-opus-4-6", "messages": []}).encode()
    result = rewrite_model_in_body(body, rewrites)
    parsed = json.loads(result)
    assert parsed["model"] == "claude-opus-4-6"


def test_rewrite_model_empty_rewrites():
    body = json.dumps({"model": "claude-sonnet-4-6", "messages": []}).encode()
    result = rewrite_model_in_body(body, {})
    parsed = json.loads(result)
    assert parsed["model"] == "claude-sonnet-4-6"


def test_rewrite_model_no_model_field():
    rewrites = {"sonnet": "openai/gpt-4o"}
    body = json.dumps({"messages": []}).encode()
    result = rewrite_model_in_body(body, rewrites)
    parsed = json.loads(result)
    assert "model" not in parsed


def test_rewrite_model_invalid_json_returns_unchanged():
    rewrites = {"sonnet": "openai/gpt-4o"}
    body = b"not json"
    result = rewrite_model_in_body(body, rewrites)
    assert result == body


def test_rewrite_model_short_alias():
    """SDK might send short alias directly (e.g. 'sonnet') without resolution."""
    rewrites = {"sonnet": "openai/gpt-4o"}
    body = json.dumps({"model": "sonnet", "messages": []}).encode()
    result = rewrite_model_in_body(body, rewrites)
    parsed = json.loads(result)
    assert parsed["model"] == "openai/gpt-4o"


def test_fallback_applied_when_no_rewrite_matches():
    """Unmapped models should be rewritten to the fallback."""
    rewrites = {"sonnet": "openai/gpt-4o"}
    fallback = "openai/gpt-4o-mini"
    body = json.dumps({"model": "claude-haiku-4-5-20251001", "messages": []}).encode()
    result = rewrite_model_in_body(body, rewrites, fallback=fallback)
    parsed = json.loads(result)
    assert parsed["model"] == "openai/gpt-4o-mini"


def test_fallback_not_applied_when_rewrite_matches():
    """Fallback should not override an explicit rewrite match."""
    rewrites = {"sonnet": "openai/gpt-4o"}
    fallback = "openai/gpt-4o-mini"
    body = json.dumps({"model": "claude-sonnet-4-6", "messages": []}).encode()
    result = rewrite_model_in_body(body, rewrites, fallback=fallback)
    parsed = json.loads(result)
    assert parsed["model"] == "openai/gpt-4o"


def test_empty_fallback_leaves_model_unchanged():
    """Empty fallback preserves existing behavior: unmatched models pass through."""
    rewrites = {"sonnet": "openai/gpt-4o"}
    body = json.dumps({"model": "claude-opus-4-6", "messages": []}).encode()
    result = rewrite_model_in_body(body, rewrites, fallback="")
    parsed = json.loads(result)
    assert parsed["model"] == "claude-opus-4-6"


def test_fallback_with_empty_rewrites():
    """Fallback should work even when rewrites map is empty."""
    body = json.dumps({"model": "claude-haiku-4-5-20251001", "messages": []}).encode()
    result = rewrite_model_in_body(body, {}, fallback="openai/gpt-4o-mini")
    parsed = json.loads(result)
    assert parsed["model"] == "openai/gpt-4o-mini"


def test_parse_model_strips_at_suffix_for_default_tool_model():
    """DEFAULT_TOOL_MODEL with @ syntax should extract only the real model."""
    _, real = parse_model("openai/gpt-4o-mini@tool-alias")
    assert real == "openai/gpt-4o-mini"


def test_parse_model_plain_value_unchanged():
    """DEFAULT_TOOL_MODEL without @ returns the value as-is."""
    _, real = parse_model("openai/gpt-4o-mini")
    assert real == "openai/gpt-4o-mini"


def test_parse_model_empty_string():
    """Empty DEFAULT_TOOL_MODEL returns empty string."""
    _, real = parse_model("")
    assert real == ""
