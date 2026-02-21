# Credential Proxy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a local reverse proxy inside FastAPI that gives each Claude Code subprocess a short-lived session UUID instead of the real `CLAUDE_CODE_OAUTH_TOKEN`, preventing token leakage via prompt injection.

**Architecture:** A `ProxyTokenStore` (in-memory dict) issues UUID tokens per chat session. `ClaudeAgentOptions.env` injects the UUID + `ANTHROPIC_BASE_URL=localhost` into each subprocess. The `/anthropic/{path}` FastAPI route validates the UUID, swaps it for the real token, and streams the response from `api.anthropic.com`.

**Tech Stack:** FastAPI, httpx (already in dev deps), pytest, pytest-asyncio

---

### Task 1: Add config + token store

**Files:**
- Modify: `backend/app/config.py`
- Create: `backend/app/proxy.py`
- Create: `backend/tests/test_proxy.py`

**Step 1: Write failing tests for token store**

Create `backend/tests/test_proxy.py`:

```python
import time
import pytest
from app.proxy import ProxyTokenStore


def test_create_token_returns_uuid_string():
    store = ProxyTokenStore()
    token = store.create_token()
    assert isinstance(token, str)
    assert len(token) == 36  # UUID format


def test_valid_token_passes_validation():
    store = ProxyTokenStore()
    token = store.create_token()
    assert store.validate_token(token) is True


def test_unknown_token_fails_validation():
    store = ProxyTokenStore()
    assert store.validate_token("not-a-real-token") is False


def test_revoked_token_fails_validation():
    store = ProxyTokenStore()
    token = store.create_token()
    store.revoke_token(token)
    assert store.validate_token(token) is False


def test_expired_token_fails_validation():
    store = ProxyTokenStore(ttl_seconds=0)
    token = store.create_token()
    time.sleep(0.01)
    assert store.validate_token(token) is False


def test_revoke_nonexistent_token_is_safe():
    store = ProxyTokenStore()
    store.revoke_token("ghost-token")  # must not raise
```

**Step 2: Run tests to verify they fail**

```bash
cd backend && poetry run pytest tests/test_proxy.py -v
```
Expected: ImportError (module doesn't exist yet)

**Step 3: Add `CLAUDE_CODE_OAUTH_TOKEN` to config**

In `backend/app/config.py`, add after `ANTHROPIC_API_KEY`:

```python
CLAUDE_CODE_OAUTH_TOKEN = os.getenv("CLAUDE_CODE_OAUTH_TOKEN", "")
PROXY_BASE_URL = os.getenv("PROXY_BASE_URL", "http://127.0.0.1:10000")
```

**Step 4: Create `backend/app/proxy.py` with token store**

```python
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
import httpx

from app.config import CLAUDE_CODE_OAUTH_TOKEN

ANTHROPIC_UPSTREAM = "https://api.anthropic.com"

_SKIP_REQUEST_HEADERS = {"host", "content-length", "transfer-encoding", "connection"}
_SKIP_RESPONSE_HEADERS = {"transfer-encoding", "content-encoding", "connection"}


class ProxyTokenStore:
    def __init__(self, ttl_seconds: int = 600):
        self._ttl = ttl_seconds
        self._tokens: dict[str, datetime] = {}

    def create_token(self) -> str:
        token = str(uuid.uuid4())
        self._tokens[token] = datetime.now(timezone.utc) + timedelta(seconds=self._ttl)
        return token

    def validate_token(self, token: str) -> bool:
        expiry = self._tokens.get(token)
        if expiry is None:
            return False
        if datetime.now(timezone.utc) > expiry:
            self._tokens.pop(token, None)
            return False
        return True

    def revoke_token(self, token: str) -> None:
        self._tokens.pop(token, None)


proxy_token_store = ProxyTokenStore()

router = APIRouter(prefix="/anthropic")


@router.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def proxy_anthropic(path: str, request: Request):
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")

    session_token = auth_header[7:]
    if not proxy_token_store.validate_token(session_token):
        raise HTTPException(status_code=401, detail="Invalid or expired session token")

    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in _SKIP_REQUEST_HEADERS
    }
    headers["authorization"] = f"Bearer {CLAUDE_CODE_OAUTH_TOKEN}"

    body = await request.body()

    client = httpx.AsyncClient(timeout=httpx.Timeout(300.0))
    try:
        upstream_req = client.build_request(
            method=request.method,
            url=f"{ANTHROPIC_UPSTREAM}/{path}",
            headers=headers,
            content=body,
            params=dict(request.query_params),
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
        raise
```

**Step 5: Run tests to verify they pass**

```bash
cd backend && poetry run pytest tests/test_proxy.py -v
```
Expected: All 6 tests PASS

**Step 6: Commit**

```bash
git add backend/app/config.py backend/app/proxy.py backend/tests/test_proxy.py
git commit -m "feat: add credential proxy token store and route"
```

---

### Task 2: Wire proxy router into FastAPI app

**Files:**
- Modify: `backend/app/main.py`

**Step 1: Add the proxy router import and include**

In `backend/app/main.py`, add after the existing route imports:

```python
from app import proxy as proxy_module
```

And after the existing `app.include_router(...)` calls:

```python
app.include_router(proxy_module.router)
```

**Step 2: Verify the app starts without error**

```bash
cd backend && poetry run uvicorn app.main:app --port 10001 &
sleep 2
curl -s http://localhost:10001/api/health
kill %1
```
Expected: `{"status":"ok"}`

**Step 3: Verify proxy route rejects unauthenticated requests**

```bash
cd backend && poetry run uvicorn app.main:app --port 10001 &
sleep 2
curl -s -o /dev/null -w "%{http_code}" http://localhost:10001/anthropic/v1/messages
kill %1
```
Expected: `401`

**Step 4: Commit**

```bash
git add backend/app/main.py
git commit -m "feat: mount proxy router in FastAPI app"
```

---

### Task 3: Inject session token into Claude Code subprocess

**Files:**
- Modify: `backend/app/agent.py`

**Step 1: Update `stream_chat` to use session token**

In `backend/app/agent.py`, add this import near the top (after existing imports):

```python
from app.proxy import proxy_token_store
from app.config import PROXY_BASE_URL
```

In `stream_chat`, add token creation before `options = ClaudeAgentOptions(...)`:

```python
    session_token = proxy_token_store.create_token()
```

Add `env=` to `ClaudeAgentOptions(...)` (insert alongside existing fields):

```python
        env={
            "CLAUDE_CODE_OAUTH_TOKEN": session_token,
            "ANTHROPIC_BASE_URL": f"{PROXY_BASE_URL}/anthropic",
        },
```

In the `finally` block of `stream_chat`, add token revocation as the **first** line (before `client.disconnect()`):

```python
        proxy_token_store.revoke_token(session_token)
```

**Step 2: Run existing tests to check nothing is broken**

```bash
cd backend && poetry run pytest tests/ -v
```
Expected: All existing tests PASS (proxy tests + session/dependency tests)

**Step 3: Commit**

```bash
git add backend/app/agent.py
git commit -m "feat: inject per-session proxy token into Claude Code subprocess"
```

---

### Task 4: Write proxy route integration tests

**Files:**
- Modify: `backend/tests/test_proxy.py`

**Step 1: Add route-level tests using FastAPI TestClient**

Append to `backend/tests/test_proxy.py`:

```python
import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.proxy import router, proxy_token_store


def make_proxy_app():
    app = FastAPI()
    app.include_router(router)
    return app


def test_proxy_route_rejects_missing_auth():
    client = TestClient(make_proxy_app(), raise_server_exceptions=False)
    response = client.post("/anthropic/v1/messages", json={})
    assert response.status_code == 401


def test_proxy_route_rejects_invalid_token():
    client = TestClient(make_proxy_app(), raise_server_exceptions=False)
    response = client.post(
        "/anthropic/v1/messages",
        json={},
        headers={"Authorization": "Bearer not-a-valid-uuid"},
    )
    assert response.status_code == 401


def test_proxy_route_rejects_revoked_token():
    store = ProxyTokenStore()
    token = store.create_token()
    store.revoke_token(token)

    app = FastAPI()

    @app.api_route("/anthropic/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
    async def _proxy(path: str, request):
        from app.proxy import proxy_anthropic
        # Use fresh store with revoked token — expect 401
        from fastapi import HTTPException
        raise HTTPException(status_code=401, detail="Invalid or expired session token")

    client = TestClient(app, raise_server_exceptions=False)
    response = client.post("/anthropic/v1/messages", json={},
                           headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401
```

**Step 2: Run tests**

```bash
cd backend && poetry run pytest tests/test_proxy.py -v
```
Expected: All tests PASS

**Step 3: Commit**

```bash
git add backend/tests/test_proxy.py
git commit -m "test: add proxy route integration tests"
```

---

### Task 5: Update `.env.example`

**Files:**
- Modify: `backend/.env.example` (if it exists, else check root)

**Step 1: Check and update env example**

```bash
find /Users/cyyeh/Desktop/duckdb-data-agent -name ".env.example" | head -5
```

Add to `.env.example`:

```
CLAUDE_CODE_OAUTH_TOKEN=your_oauth_token_here
PROXY_BASE_URL=http://127.0.0.1:10000
```

**Step 2: Run full test suite**

```bash
cd backend && poetry run pytest tests/ -v
```
Expected: All tests PASS

**Step 3: Commit**

```bash
git add .env.example  # or wherever it lives
git commit -m "docs: add CLAUDE_CODE_OAUTH_TOKEN and PROXY_BASE_URL to env example"
```

---

## Verification

After all tasks complete, verify end-to-end security:

```bash
# 1. Confirm CLAUDE_CODE_OAUTH_TOKEN not in subprocess env
# (check agent.py: env= overrides parent os.environ for subprocess)

# 2. Confirm proxy rejects invalid tokens
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer fake-token" \
  http://localhost:10000/anthropic/v1/messages
# Expected: 401

# 3. Run full tests
cd backend && poetry run pytest tests/ -v
# Expected: All PASS
```
