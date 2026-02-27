import json
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
