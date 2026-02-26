# Bifrost LLM Gateway Integration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the custom credential proxy (`proxy.py`) with Bifrost as a Docker Compose service, enabling multi-provider LLM routing for both orchestrator and subagent models.

**Architecture:** Bifrost runs as a new Docker Compose service. Sidecar containers point `ANTHROPIC_BASE_URL` to Bifrost's native `/anthropic` endpoint. Bifrost manages all provider API keys centrally. The custom `proxy.py` and `ProxyTokenStore` are removed entirely.

**Tech Stack:** Bifrost (Go, Docker image `maximhq/bifrost`), Docker Compose, Python/FastAPI backend

**Design doc:** `docs/plans/2026-02-26-bifrost-llm-gateway-design.md`

---

### Task 1: Create Bifrost Configuration File

**Files:**
- Create: `bifrost/config.json`

**Step 1: Create the Bifrost config directory and config file**

Create `bifrost/config.json`:

```json
{
  "providers": {
    "anthropic": {
      "keys": [
        {
          "name": "default",
          "value": "env.ANTHROPIC_API_KEY",
          "models": [],
          "weight": 1.0
        }
      ]
    }
  }
}
```

This tells Bifrost to read the real Anthropic API key from the `ANTHROPIC_API_KEY` environment variable. Additional providers (OpenAI, Bedrock, etc.) can be added later.

**Step 2: Commit**

```bash
git add bifrost/config.json
git commit -m "feat: add Bifrost provider configuration"
```

---

### Task 2: Add Bifrost Service to Docker Compose

**Files:**
- Modify: `docker-compose.yml`

**Step 1: Add `bifrost` service and update `app` service**

Replace the entire `docker-compose.yml` with:

```yaml
services:
  bifrost:
    image: maximhq/bifrost:latest
    container_name: bifrost
    ports:
      - "${BIFROST_PORT:-8081}:8080"
    volumes:
      - ./bifrost/config.json:/app/data/config.json
    environment:
      APP_HOST: "0.0.0.0"
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
    networks:
      - agent-sandbox
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:8080/health"]
      interval: 10s
      timeout: 5s
      retries: 3
    restart: unless-stopped

  app:
    build:
      context: .
      dockerfile: backend/Dockerfile
    image: duckdb-data-agent:latest
    container_name: duckdb-data-agent
    ports:
      - "${APP_PORT:-10000}:10000"
    env_file:
      - backend/.env
    environment:
      CONTAINER_IMAGE: duckdb-agent-sidecar:latest
      CONTAINER_NETWORK: agent-sandbox
      BIFROST_BASE_URL: http://bifrost:8080
      BACKEND_BASE_URL: http://duckdb-data-agent:10000
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    group_add:
      - "${DOCKER_GID:-0}"
    networks:
      - agent-sandbox
    depends_on:
      bifrost:
        condition: service_healthy
    restart: unless-stopped

  sidecar:
    build:
      context: ./sidecar
      dockerfile: Dockerfile
    image: duckdb-agent-sidecar:latest
    profiles:
      - sidecar
    # Never started directly — exists only so `docker compose build`
    # produces the sidecar image. The app spawns sidecar containers
    # on-demand via Docker SDK.

networks:
  agent-sandbox:
    name: agent-sandbox
    external: true
```

Key changes from the original:
- New `bifrost` service with healthcheck, config mount, and env var for the API key
- `app` service: replaced `PROXY_BASE_URL` with `BIFROST_BASE_URL` and `BACKEND_BASE_URL`
- `app` service: added `depends_on: bifrost: condition: service_healthy`

**Step 2: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: add Bifrost service to Docker Compose"
```

---

### Task 3: Update `config.py` — Replace Proxy Config with Bifrost Config

**Files:**
- Modify: `backend/app/config.py`

**Step 1: Replace PROXY_BASE_URL and ANTHROPIC_API_KEY**

In `backend/app/config.py`, make these changes:

1. Remove the `ANTHROPIC_API_KEY` variable and its warning block (lines 6-13)
2. Replace `PROXY_BASE_URL` (line 14) with two new variables:

The final `config.py` should look like:

```python
import os
from dotenv import load_dotenv

load_dotenv()

BIFROST_BASE_URL = os.getenv("BIFROST_BASE_URL", "http://bifrost:8080")
BACKEND_BASE_URL = os.getenv("BACKEND_BASE_URL", "http://duckdb-data-agent:10000")
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-6")
SQL_SUBAGENT_MODEL = os.getenv("SQL_SUBAGENT_MODEL", "haiku")
CHART_SUBAGENT_MODEL = os.getenv("CHART_SUBAGENT_MODEL", "haiku")

LANGFUSE_PUBLIC_KEY = os.getenv("LANGFUSE_PUBLIC_KEY", "")
LANGFUSE_SECRET_KEY = os.getenv("LANGFUSE_SECRET_KEY", "")
LANGFUSE_BASE_URL = os.getenv("LANGFUSE_BASE_URL", "https://cloud.langfuse.com")
LANGFUSE_ENABLED = bool(LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY)

PROJECT_DIR = os.getenv("PROJECT_DIR", os.getcwd())
MAX_TOTAL_SIZE_BYTES = int(os.getenv("MAX_TOTAL_SIZE_BYTES", str(500 * 1024 * 1024)))  # default 500MB

# Container isolation settings
CONTAINER_IMAGE = os.getenv("CONTAINER_IMAGE", "duckdb-agent-sidecar:latest")
CONTAINER_RUNTIME = os.getenv("CONTAINER_RUNTIME", "runc")
CONTAINER_MEMORY_LIMIT = os.getenv("CONTAINER_MEMORY_LIMIT", "512m")
CONTAINER_CPU_LIMIT = float(os.getenv("CONTAINER_CPU_LIMIT", "0.5"))
CONTAINER_MAX_LIFETIME_SECONDS = int(os.getenv("CONTAINER_MAX_LIFETIME_SECONDS", "600"))
CONTAINER_NETWORK = os.getenv("CONTAINER_NETWORK", "agent-sandbox")
# CORS: comma-separated list of allowed origins, or "*" for all (no credentials).
# In production set to your actual frontend origin, e.g. "https://myapp.example.com".
CORS_ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv("CORS_ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:8000").split(",")
    if o.strip()
]
```

**Step 2: Commit**

```bash
git add backend/app/config.py
git commit -m "feat: replace PROXY_BASE_URL with BIFROST_BASE_URL and BACKEND_BASE_URL"
```

---

### Task 4: Update `agent.py` — Remove Proxy Token Logic, Use Bifrost URLs

**Files:**
- Modify: `backend/app/agent.py`

This is the largest change. There are 5 edits to make in this file.

**Step 1: Update imports (line 8-13)**

Replace:
```python
from app.config import (
    ANTHROPIC_MODEL, PROXY_BASE_URL,
    LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL, LANGFUSE_ENABLED,
    SQL_SUBAGENT_MODEL, CHART_SUBAGENT_MODEL,
)
from app.proxy import proxy_token_store
```

With:
```python
from app.config import (
    ANTHROPIC_MODEL, BIFROST_BASE_URL, BACKEND_BASE_URL,
    LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL, LANGFUSE_ENABLED,
    SQL_SUBAGENT_MODEL, CHART_SUBAGENT_MODEL,
)
```

(Removes `PROXY_BASE_URL` import, adds `BIFROST_BASE_URL` and `BACKEND_BASE_URL`, removes `proxy_token_store` import entirely.)

**Step 2: Remove token creation and update sidecar env vars (lines 185-204)**

Replace:
```python
    session_token = proxy_token_store.create_token()

    # Pass Langfuse credentials to the container so the sidecar's
    # TypeScript Langfuse SDK can create traces directly.
    env: dict[str, str] = {
        "ANTHROPIC_API_KEY": session_token,
        "ANTHROPIC_BASE_URL": f"{PROXY_BASE_URL}/anthropic",
    }
    if LANGFUSE_ENABLED:
        env["LANGFUSE_PUBLIC_KEY"] = LANGFUSE_PUBLIC_KEY
        env["LANGFUSE_SECRET_KEY"] = LANGFUSE_SECRET_KEY
        env["LANGFUSE_BASE_URL"] = LANGFUSE_BASE_URL

    if "127.0.0.1" in PROXY_BASE_URL or "localhost" in PROXY_BASE_URL:
        logger.warning(
            "PROXY_BASE_URL=%s uses localhost which is unreachable from containers. "
            "Set PROXY_BASE_URL to the host's Docker-accessible address "
            "(e.g., http://host.docker.internal:10000).",
            PROXY_BASE_URL,
        )
```

With:
```python
    # Pass Langfuse credentials to the container so the sidecar's
    # TypeScript Langfuse SDK can create traces directly.
    env: dict[str, str] = {
        "ANTHROPIC_API_KEY": "placeholder",
        "ANTHROPIC_BASE_URL": f"{BIFROST_BASE_URL}/anthropic",
    }
    if LANGFUSE_ENABLED:
        env["LANGFUSE_PUBLIC_KEY"] = LANGFUSE_PUBLIC_KEY
        env["LANGFUSE_SECRET_KEY"] = LANGFUSE_SECRET_KEY
        env["LANGFUSE_BASE_URL"] = LANGFUSE_BASE_URL
```

**Step 3: Update sidecar query payload (lines 256-260)**

Replace:
```python
            "mcp_server_url": f"{PROXY_BASE_URL}/mcp/sse?session_id={stable_session}",
            "env": {
                "ANTHROPIC_API_KEY": session_token,
                "ANTHROPIC_BASE_URL": f"{PROXY_BASE_URL}/anthropic",
            },
```

With:
```python
            "mcp_server_url": f"{BACKEND_BASE_URL}/mcp/sse?session_id={stable_session}",
            "env": {
                "ANTHROPIC_API_KEY": "placeholder",
                "ANTHROPIC_BASE_URL": f"{BIFROST_BASE_URL}/anthropic",
            },
```

**Step 4: Remove the `finally` block's token revocation (lines 525-534)**

Replace the entire `finally` block:
```python
    finally:
        # Delay token revocation so the container's CLI subprocess can finish
        # any in-flight API calls after the stream ends.  The container is
        # intentionally kept alive for session resume (--resume flag) and is
        # cleaned up by the background cleanup loop after
        # CONTAINER_MAX_LIFETIME_SECONDS, or on application shutdown.
        async def _delayed_revoke(token: str, delay: float = 10.0) -> None:
            await asyncio.sleep(delay)
            proxy_token_store.revoke_token(token)
        asyncio.create_task(_delayed_revoke(session_token))
```

With:
```python
    finally:
        # Container is kept alive for session resume (--resume flag) and is
        # cleaned up by the background cleanup loop after
        # CONTAINER_MAX_LIFETIME_SECONDS, or on application shutdown.
        pass
```

**Step 5: Verify no remaining references to proxy**

Run: `grep -n "proxy\|PROXY_BASE_URL\|session_token" backend/app/agent.py`
Expected: No matches (zero output).

**Step 6: Commit**

```bash
git add backend/app/agent.py
git commit -m "feat: route sidecar LLM calls through Bifrost, remove proxy token logic"
```

---

### Task 5: Update `main.py` — Remove Proxy Router and Cleanup

**Files:**
- Modify: `backend/app/main.py`

**Step 1: Remove proxy import (line 12)**

Remove this line:
```python
from app import proxy as proxy_module
```

**Step 2: Remove proxy token cleanup from `_cleanup_loop` (lines 29-31)**

Remove these lines from the `_cleanup_loop` function:
```python
            proxy_removed = proxy_module.proxy_token_store.cleanup_expired()
            if proxy_removed:
                logger.info("Background cleanup: removed %d expired proxy tokens", proxy_removed)
```

**Step 3: Remove proxy router inclusion (line 70)**

Remove this line:
```python
app.include_router(proxy_module.router)
```

**Step 4: Verify no remaining proxy references**

Run: `grep -n "proxy" backend/app/main.py`
Expected: No matches.

**Step 5: Commit**

```bash
git add backend/app/main.py
git commit -m "feat: remove proxy router and token cleanup from main.py"
```

---

### Task 6: Delete `proxy.py`

**Files:**
- Delete: `backend/app/proxy.py`

**Step 1: Verify no other files import from proxy.py**

Run: `grep -rn "from app.proxy\|from app import proxy\|import proxy" backend/`
Expected: No matches (after Tasks 4 and 5 are complete).

**Step 2: Delete the file**

```bash
git rm backend/app/proxy.py
```

**Step 3: Commit**

```bash
git commit -m "feat: remove credential proxy (replaced by Bifrost gateway)"
```

---

### Task 7: Update `.env.example`

**Files:**
- Modify: `backend/.env.example`

**Step 1: Replace PROXY_BASE_URL with Bifrost config**

Replace the contents of `backend/.env.example` with:

```
ANTHROPIC_API_KEY=your-api-key-here
ANTHROPIC_MODEL=haiku
# Subagent models (default: haiku). Use provider prefixes for non-Anthropic models:
# e.g., openai/gpt-4o-mini, bedrock/claude-3-haiku
SQL_SUBAGENT_MODEL=haiku
CHART_SUBAGENT_MODEL=haiku

# Bifrost LLM Gateway (manages API keys and multi-provider routing)
# BIFROST_BASE_URL is set in docker-compose.yml; override here for local dev
# BIFROST_BASE_URL=http://localhost:8081
# BACKEND_BASE_URL is set in docker-compose.yml; override here for local dev
# BACKEND_BASE_URL=http://localhost:10000

LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_BASE_URL=https://cloud.langfuse.com
# Maximum total upload file size in bytes (default: 500MB)
MAX_TOTAL_SIZE_BYTES=524288000

# Container settings (Docker required)
CONTAINER_IMAGE=duckdb-agent-sidecar:latest
CONTAINER_RUNTIME=runc  # use `runsc` for gVisor
CONTAINER_MEMORY_LIMIT=512m
CONTAINER_CPU_LIMIT=0.5
CONTAINER_MAX_LIFETIME_SECONDS=600
CONTAINER_NETWORK=agent-sandbox
# Comma-separated list of allowed CORS origins (default: localhost dev servers)
# CORS_ALLOWED_ORIGINS=https://myapp.example.com
```

Key changes: removed `PROXY_BASE_URL`, added comments about `BIFROST_BASE_URL` and `BACKEND_BASE_URL` (set via docker-compose), added provider prefix examples for subagent models.

**Step 2: Commit**

```bash
git add backend/.env.example
git commit -m "docs: update .env.example for Bifrost gateway configuration"
```

---

### Task 8: Smoke Test

**Step 1: Build and start the stack**

```bash
docker network create agent-sandbox 2>/dev/null || true
docker compose build
docker compose up -d
```

**Step 2: Verify Bifrost is healthy**

```bash
docker compose ps
# Expected: bifrost shows "healthy"
curl http://localhost:8081/health
# Expected: 200 OK
```

**Step 3: Verify Bifrost Web UI**

Open `http://localhost:8081` in browser. Should see Bifrost admin dashboard with the Anthropic provider configured.

**Step 4: Send a test chat message**

Use the frontend at `http://localhost:10000` or curl the chat API. Verify:
- Response streams back correctly
- No errors in `docker compose logs app`
- No errors in `docker compose logs bifrost`

**Step 5: Verify multi-provider routing (optional)**

If you have an OpenAI API key, add it to `bifrost/config.json`:
```json
{
  "providers": {
    "anthropic": { ... },
    "openai": {
      "keys": [{ "name": "default", "value": "env.OPENAI_API_KEY", "weight": 1.0 }]
    }
  }
}
```

Set `SQL_SUBAGENT_MODEL=openai/gpt-4o-mini` in `backend/.env`, restart, and verify the subagent uses GPT-4o-mini.
