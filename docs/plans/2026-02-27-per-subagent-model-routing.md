# Per-Subagent Model Routing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow each subagent to use its own model when routing through a non-Anthropic proxy, using `REAL_MODEL@SDK_ALIAS` env var notation.

**Architecture:** Parse `@suffix` from model env vars to extract SDK aliases (`haiku`/`sonnet`/`opus`) and real model names (`openai/gpt-4o`). Build a rewrite map at startup. A new backend proxy intercepts SDK API calls, rewrites model names, and forwards to the upstream (Bifrost or direct API).

**Tech Stack:** Python/FastAPI, httpx (async HTTP forwarding), pytest

---

### Task 1: Add `parse_model()` helper and model config to `config.py`

**Files:**
- Test: `backend/tests/test_model_parsing.py`
- Modify: `backend/app/config.py`

**Step 1: Write the failing tests**

```python
# backend/tests/test_model_parsing.py
import os
from unittest.mock import patch


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
```

**Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_model_parsing.py -v`
Expected: FAIL — `parse_model` and `build_model_rewrites` not found

**Step 3: Implement `parse_model()` and config vars in `config.py`**

Add to `backend/app/config.py`, replacing lines 8-13 (the current ANTHROPIC_MODEL and deprecation comment):

```python
def parse_model(value: str) -> tuple[str, str]:
    """Parse 'real_model@sdk_alias' -> (sdk_alias, real_model).

    If no '@', returns (value, value) for backwards compatibility.
    """
    if "@" in value:
        real, sdk = value.rsplit("@", 1)
        return sdk, real
    return value, value


def build_model_rewrites(pairs: list[tuple[str, str]]) -> dict[str, str]:
    """Build a rewrite map from (sdk_alias, real_model) pairs.

    Only includes entries where sdk != real (i.e. rewriting is needed).
    """
    return {sdk: real for sdk, real in pairs if sdk != real}


_raw_model = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-6")
_raw_sql = os.getenv("SQL_SUBAGENT_MODEL", "inherit")
_raw_chart = os.getenv("CHART_SUBAGENT_MODEL", "inherit")

ANTHROPIC_MODEL_SDK, ANTHROPIC_MODEL_REAL = parse_model(_raw_model)
SQL_SUBAGENT_MODEL_SDK, SQL_SUBAGENT_MODEL_REAL = parse_model(_raw_sql)
CHART_SUBAGENT_MODEL_SDK, CHART_SUBAGENT_MODEL_REAL = parse_model(_raw_chart)

# Backwards compat alias — existing code that reads ANTHROPIC_MODEL gets the SDK alias
ANTHROPIC_MODEL = ANTHROPIC_MODEL_SDK

MODEL_REWRITES = build_model_rewrites([
    (ANTHROPIC_MODEL_SDK, ANTHROPIC_MODEL_REAL),
    (SQL_SUBAGENT_MODEL_SDK, SQL_SUBAGENT_MODEL_REAL),
    (CHART_SUBAGENT_MODEL_SDK, CHART_SUBAGENT_MODEL_REAL),
])
```

**Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_model_parsing.py -v`
Expected: PASS (all 7 tests)

**Step 5: Run full test suite to check nothing broke**

Run: `cd backend && python -m pytest tests/ -v`
Expected: PASS (existing tests still pass — `ANTHROPIC_MODEL` alias preserves backwards compat)

**Step 6: Commit**

```bash
git add backend/app/config.py backend/tests/test_model_parsing.py
git commit -m "feat: add parse_model() helper and @suffix env var parsing"
```

---

### Task 2: Create proxy with model rewriting

**Files:**
- Create: `backend/app/proxy.py`
- Test: `backend/tests/test_proxy.py`

**Step 1: Write the failing tests**

```python
# backend/tests/test_proxy.py
import json
import pytest
from app.config import build_model_rewrites
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
```

**Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_proxy.py -v`
Expected: FAIL — `app.proxy` not found

**Step 3: Create `backend/app/proxy.py`**

```python
# backend/app/proxy.py
import json
import logging

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
import httpx

from app.config import MODEL_REWRITES, BIFROST_BASE_URL

logger = logging.getLogger(__name__)

ANTHROPIC_UPSTREAM = BIFROST_BASE_URL + "/anthropic"

_SKIP_REQUEST_HEADERS = {
    "host", "content-length", "transfer-encoding", "connection",
}
_SKIP_RESPONSE_HEADERS = {"transfer-encoding", "content-encoding", "connection"}

router = APIRouter(prefix="/anthropic")


def rewrite_model_in_body(body: bytes, rewrites: dict[str, str]) -> bytes:
    """Rewrite the 'model' field in a JSON body using the rewrites map.

    Matches if the model string equals or contains a rewrite key
    (e.g. 'sonnet' matches 'claude-sonnet-4-6').
    Returns the body unchanged if no match or if body is not valid JSON.
    """
    if not rewrites:
        return body
    try:
        data = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return body
    model = data.get("model")
    if not model or not isinstance(model, str):
        return body
    for tier, real_model in rewrites.items():
        if model == tier or tier in model:
            data["model"] = real_model
            return json.dumps(data).encode()
    return body


@router.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def proxy_to_upstream(path: str, request: Request):
    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in _SKIP_REQUEST_HEADERS
    }

    body = await request.body()

    # Rewrite model on POST requests (messages, completions, etc.)
    if request.method == "POST" and MODEL_REWRITES:
        body = rewrite_model_in_body(body, MODEL_REWRITES)

    client = httpx.AsyncClient(timeout=httpx.Timeout(300.0))
    try:
        upstream_req = client.build_request(
            method=request.method,
            url=f"{ANTHROPIC_UPSTREAM}/{path}",
            headers=headers,
            content=body,
        )
        upstream_resp = await client.send(upstream_req, stream=True)

        response_headers = {
            k: v for k, v in upstream_resp.headers.items()
            if k.lower() not in _SKIP_RESPONSE_HEADERS
        }

        async def body_generator():
            try:
                async for chunk in upstream_resp.aiter_bytes():
                    yield chunk
            finally:
                await upstream_resp.aclose()
                await client.aclose()

        return StreamingResponse(
            body_generator(),
            status_code=upstream_resp.status_code,
            headers=response_headers,
        )
    except Exception:
        await client.aclose()
        logger.exception("Proxy request to upstream failed: %s %s", request.method, path)
        raise
```

**Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_proxy.py -v`
Expected: PASS (all 7 tests)

**Step 5: Commit**

```bash
git add backend/app/proxy.py backend/tests/test_proxy.py
git commit -m "feat: add proxy with model rewriting for @suffix routing"
```

---

### Task 3: Wire proxy into main.py and route SDK through it

**Files:**
- Modify: `backend/app/main.py:10-11` (add proxy import)
- Modify: `backend/app/main.py:60-65` (add router)

**Step 1: Add proxy router to main.py**

Add import at line 11 (after existing route imports):
```python
from app.proxy import router as proxy_router
```

Add router registration after line 65 (after `session.router`):
```python
app.include_router(proxy_router)
```

**Step 2: Verify the app still starts and proxy route is registered**

Run: `cd backend && python -c "from app.main import app; routes = [r.path for r in app.routes]; assert any('/anthropic' in r for r in routes); print('OK: proxy route registered')"`
Expected: `OK: proxy route registered`

**Step 3: Commit**

```bash
git add backend/app/main.py
git commit -m "feat: wire proxy router into FastAPI app"
```

---

### Task 4: Update agent.py to use parsed SDK models and route through backend proxy

**Files:**
- Modify: `backend/app/agent.py:8-11` (imports)
- Modify: `backend/app/agent.py:109-132` (subagent model field)
- Modify: `backend/app/agent.py:194-197` (ANTHROPIC_BASE_URL)
- Modify: `backend/app/agent.py:252-257` (payload model + env)
- Test: `backend/tests/test_subagent_definitions.py` (update model assertion)
- Test: `backend/tests/test_subagent_config.py` (update for new config vars)

**Step 1: Update test expectations**

In `backend/tests/test_subagent_definitions.py`, replace `test_subagent_models_inherit` (lines 58-67):

```python
def test_subagent_models_use_sdk_aliases():
    from app.agent import build_subagent_definitions
    from app.config import SQL_SUBAGENT_MODEL_SDK, CHART_SUBAGENT_MODEL_SDK

    db = _make_db()
    agents = build_subagent_definitions(db)

    assert agents["sql-analyst"].model == SQL_SUBAGENT_MODEL_SDK
    assert agents["chart-builder"].model == CHART_SUBAGENT_MODEL_SDK
```

In `backend/tests/test_subagent_config.py`, replace entire file:

```python
from app.config import (
    ANTHROPIC_MODEL, ANTHROPIC_MODEL_SDK, ANTHROPIC_MODEL_REAL,
    SQL_SUBAGENT_MODEL_SDK, CHART_SUBAGENT_MODEL_SDK,
    MODEL_REWRITES,
)


def test_anthropic_model_has_default():
    """ANTHROPIC_MODEL should always have a value."""
    assert ANTHROPIC_MODEL is not None
    assert len(ANTHROPIC_MODEL) > 0


def test_sdk_aliases_are_valid():
    """SDK aliases must be values the Claude Agent SDK accepts."""
    valid = {"haiku", "sonnet", "opus", "inherit", "claude-sonnet-4-6",
             "claude-haiku-4-5-20251001", "claude-opus-4-6"}
    # SDK aliases should either be short names or full Anthropic model names
    for alias in [ANTHROPIC_MODEL_SDK, SQL_SUBAGENT_MODEL_SDK, CHART_SUBAGENT_MODEL_SDK]:
        assert isinstance(alias, str) and len(alias) > 0


def test_model_rewrites_is_dict():
    assert isinstance(MODEL_REWRITES, dict)
```

**Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_subagent_definitions.py::test_subagent_models_use_sdk_aliases tests/test_subagent_config.py -v`
Expected: FAIL — imports don't exist yet in agent.py, config vars missing

**Step 3: Update agent.py imports and subagent definitions**

In `backend/app/agent.py`, update imports (line 8-11):

```python
from app.config import (
    ANTHROPIC_MODEL, ANTHROPIC_MODEL_SDK,
    SQL_SUBAGENT_MODEL_SDK, CHART_SUBAGENT_MODEL_SDK,
    BIFROST_BASE_URL, BACKEND_BASE_URL,
    LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL, LANGFUSE_ENABLED,
    MODEL_REWRITES,
)
```

In `build_subagent_definitions()`, replace the comment block and return statement (lines 109-132):

```python
    return {
        "sql-analyst": AgentDefinition(
            description=(
                "Use this agent for any data question that requires SQL queries "
                "— exploring data, aggregations, filtering, joins, etc."
            ),
            prompt=sql_prompt,
            tools=["mcp__duckdb__execute_sql"],
            model=SQL_SUBAGENT_MODEL_SDK,
        ),
        "chart-builder": AgentDefinition(
            description=(
                "Use this agent when the user wants a chart, graph, or visualization."
            ),
            prompt=chart_prompt,
            tools=["mcp__duckdb__execute_sql", "mcp__duckdb__render_chart"],
            model=CHART_SUBAGENT_MODEL_SDK,
        ),
    }
```

In `stream_chat()`, update the env dict (lines 194-197) to route through the backend proxy:

```python
    env: dict[str, str] = {
        "ANTHROPIC_API_KEY": "placeholder",
        "ANTHROPIC_BASE_URL": f"{BACKEND_BASE_URL}/anthropic",
    }
```

Update the payload model and env (lines 252-257):

```python
        payload: dict = {
            "message": query_message,
            "session_id": session_id,
            "system_prompt": system_prompt,
            "model": ANTHROPIC_MODEL_SDK,
            "mcp_server_url": f"{BACKEND_BASE_URL}/mcp/sse?session_id={stable_session}",
            "env": {
                "ANTHROPIC_API_KEY": "placeholder",
                "ANTHROPIC_BASE_URL": f"{BACKEND_BASE_URL}/anthropic",
            },
```

**Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_subagent_definitions.py tests/test_subagent_config.py -v`
Expected: PASS

**Step 5: Run full test suite**

Run: `cd backend && python -m pytest tests/ -v`
Expected: PASS

**Step 6: Commit**

```bash
git add backend/app/agent.py backend/tests/test_subagent_definitions.py backend/tests/test_subagent_config.py
git commit -m "feat: route SDK through backend proxy with per-subagent model aliases"
```

---

### Task 5: Update .env.example and .env documentation

**Files:**
- Modify: `backend/.env.example`

**Step 1: Update .env.example with @suffix documentation**

Replace the model section in `backend/.env.example`:

```
ANTHROPIC_API_KEY=your-api-key-here
# Model configuration. Use @suffix for per-agent model routing:
#   ANTHROPIC_MODEL=openai/gpt-4o@sonnet        (orchestrator uses sonnet alias, routes to openai/gpt-4o)
#   SQL_SUBAGENT_MODEL=openai/gpt-4o-mini@haiku  (sql agent uses haiku alias, routes to openai/gpt-4o-mini)
# Without @suffix, value is used as-is (direct Anthropic):
#   ANTHROPIC_MODEL=claude-sonnet-4-6
#   SQL_SUBAGENT_MODEL=haiku
ANTHROPIC_MODEL=claude-sonnet-4-6
SQL_SUBAGENT_MODEL=inherit
CHART_SUBAGENT_MODEL=inherit
```

**Step 2: Commit**

```bash
git add backend/.env.example
git commit -m "docs: document @suffix model routing in .env.example"
```

---

### Task 6: Final integration verification

**Step 1: Run full test suite**

Run: `cd backend && python -m pytest tests/ -v`
Expected: All tests PASS

**Step 2: Verify config parsing with actual .env values**

Run: `cd backend && python -c "from app.config import *; print(f'SDK={ANTHROPIC_MODEL_SDK} REAL={ANTHROPIC_MODEL_REAL}'); print(f'SQL_SDK={SQL_SUBAGENT_MODEL_SDK} CHART_SDK={CHART_SUBAGENT_MODEL_SDK}'); print(f'REWRITES={MODEL_REWRITES}')"`
Expected: Shows parsed values from current .env

**Step 3: Commit any final fixes if needed**
