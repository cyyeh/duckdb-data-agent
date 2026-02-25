# Remove Subprocess Mode — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the agent subprocess mode so only the sidecar/container mode remains, delete Render deployment support, and update the README.

**Architecture:** The `stream_chat()` dispatcher in `agent.py` currently branches between container mode and subprocess mode based on `CONTAINER_ENABLED`. We remove the subprocess branch entirely, promote the container path to be the only path, delete subprocess-only files (`tools.py`, root `Dockerfile`, `render.yaml`), and simplify config/startup code that conditionally checked `CONTAINER_ENABLED`.

**Tech Stack:** Python (FastAPI), Docker, Docker Compose

---

### Task 1: Delete subprocess-only files

**Files:**
- Delete: `backend/app/tools.py`
- Delete: `backend/tests/test_tools.py`
- Delete: `backend/tests/test_agent_container.py`
- Delete: `Dockerfile` (root)
- Delete: `render.yaml`

**Step 1: Delete the files**

```bash
rm backend/app/tools.py
rm backend/tests/test_tools.py
rm backend/tests/test_agent_container.py
rm Dockerfile
rm render.yaml
```

**Step 2: Run tests to check nothing else breaks**

Run: `cd backend && poetry run pytest --tb=short -q`
Expected: Some tests may fail due to imports of deleted `tools.py` — that's expected and will be fixed in Task 2.

**Step 3: Commit**

```bash
git add -u
git commit -m "chore: delete subprocess-only files (tools.py, root Dockerfile, render.yaml)"
```

---

### Task 2: Simplify `backend/app/agent.py`

**Files:**
- Modify: `backend/app/agent.py`

**Step 1: Remove subprocess-specific imports (lines 7-19, 31-51)**

Remove these imports and the monkey-patch block:

```python
# REMOVE these imports (lines 7-18):
from claude_agent_sdk import (
    AgentDefinition,
    ClaudeSDKClient,
    ClaudeAgentOptions,
    AssistantMessage,
    UserMessage,
    ResultMessage,
    ToolUseBlock,
    ToolResultBlock,
)
from claude_agent_sdk.types import StreamEvent, SystemMessage
from claude_agent_sdk._errors import MessageParseError
from app.tools import create_duckdb_server

# KEEP AgentDefinition import (used by build_subagent_definitions):
from claude_agent_sdk import AgentDefinition

# REMOVE the CONTAINER_ENABLED import from config line:
# Change: ANTHROPIC_MODEL, PROXY_BASE_URL, CONTAINER_ENABLED,
# To:    ANTHROPIC_MODEL, PROXY_BASE_URL,

# REMOVE monkey-patch block (lines 31-51):
import claude_agent_sdk._internal.message_parser as _parser
... (entire block through line 51)
```

The resulting imports should be:

```python
import asyncio
import json
import logging
import re
from typing import AsyncIterator

from claude_agent_sdk import AgentDefinition
from app.database import Database
from app.config import (
    ANTHROPIC_MODEL, PROXY_BASE_URL,
    LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL, LANGFUSE_ENABLED,
    SQL_SUBAGENT_MODEL, CHART_SUBAGENT_MODEL,
)
from app.proxy import proxy_token_store
from app.tracing import get_langfuse_client

logger = logging.getLogger(__name__)
```

**Step 2: Rename `_stream_chat_container()` to `stream_chat()` and remove the old dispatcher**

Replace the old `stream_chat()` function (lines 580-962) and the `_stream_chat_container()` definition (line 218) so that:
- `_stream_chat_container()` (lines 218-578) becomes `stream_chat()`
- Remove the `container_manager` parameter (import it inside the function instead, as it does now)
- Remove the old `stream_chat()` dispatcher (lines 580-962) entirely
- Update the signature to match what callers expect:

```python
async def stream_chat(
    message: str,
    session_id: str | None = None,
    db: Database | None = None,
    conversation_history: list[dict] | None = None,
    langfuse_session_id: str | None = None,
    backend_session_id: str | None = None,
) -> AsyncIterator[str]:
    """Stream agent chat responses as SSE events via containerized sidecar."""
    from app.container_manager import container_manager
    if container_manager is None:
        raise RuntimeError("Docker is not available. Container mode requires Docker.")
    # ... rest of existing _stream_chat_container body, but using the function args directly
    # (no need for the container_manager parameter since it's imported)
```

The body keeps the existing `_stream_chat_container` logic unchanged, just remove the leading underscore and extra `container_manager` parameter.

**Step 3: Remove `_extract_tool_result_text()` helper (lines 203-215)**

This helper is only used by the subprocess streaming loop. Delete it.

**Step 4: Run tests**

Run: `cd backend && poetry run pytest --tb=short -q`
Expected: PASS (tests that import from `agent.py` like `test_subagent_definitions.py` should still work since `build_subagent_definitions` and `build_system_prompt` are unchanged)

**Step 5: Commit**

```bash
git add backend/app/agent.py
git commit -m "refactor: remove subprocess code path from agent.py, promote container mode"
```

---

### Task 3: Simplify `backend/app/config.py` and `backend/.env.example`

**Files:**
- Modify: `backend/app/config.py`
- Modify: `backend/.env.example`

**Step 1: Remove `CONTAINER_ENABLED` from config.py (line 28)**

Delete this line:
```python
CONTAINER_ENABLED = os.getenv("CONTAINER_ENABLED", "false").lower() == "true"
```

**Step 2: Remove `CONTAINER_ENABLED` from `.env.example` (line 14)**

Delete this line:
```
CONTAINER_ENABLED=false
```

Also update the comment on line 13 from "Container isolation (requires Docker)" to "Container settings (Docker required)".

**Step 3: Run tests**

Run: `cd backend && poetry run pytest --tb=short -q`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/app/config.py backend/.env.example
git commit -m "chore: remove CONTAINER_ENABLED flag from config"
```

---

### Task 4: Simplify `backend/app/main.py`

**Files:**
- Modify: `backend/app/main.py`

**Step 1: Remove conditional CONTAINER_ENABLED checks**

Replace the conditional import and checks with unconditional container manager usage:

```python
# Remove this import:
from app.config import CONTAINER_ENABLED

# Add unconditional import:
from app.container_manager import container_manager
```

Update `_cleanup_loop()` — remove the `if CONTAINER_ENABLED:` guard (lines 32-36):

```python
# Change from:
            if CONTAINER_ENABLED:
                from app.container_manager import container_manager
                container_removed = container_manager.cleanup_expired()
                if container_removed:
                    logger.info(...)

# To:
            if container_manager is not None:
                container_removed = container_manager.cleanup_expired()
                if container_removed:
                    logger.info("Background cleanup: removed %d expired containers", container_removed)
```

Update `lifespan()` — remove the `if CONTAINER_ENABLED:` guard (lines 46-48):

```python
# Change from:
    if CONTAINER_ENABLED:
        from app.container_manager import container_manager
        container_manager.shutdown_all()

# To:
    if container_manager is not None:
        container_manager.shutdown_all()
```

**Step 2: Run tests**

Run: `cd backend && poetry run pytest --tb=short -q`
Expected: PASS

**Step 3: Commit**

```bash
git add backend/app/main.py
git commit -m "refactor: remove CONTAINER_ENABLED conditionals from main.py"
```

---

### Task 5: Update `docker-compose.yml`

**Files:**
- Modify: `docker-compose.yml`

**Step 1: Remove CONTAINER_ENABLED from environment block**

Remove this line from the `app` service environment:
```yaml
      CONTAINER_ENABLED: "true"
```

The `app` service in docker-compose still needs to build from the sidecar Dockerfile context. However, the root `Dockerfile` was deleted in Task 1. The docker-compose `app` service currently references `dockerfile: Dockerfile` (root). We need to update it to build from `backend/` context or create an equivalent.

Actually, looking at the docker-compose, the `app` service builds from root `Dockerfile`. Since we deleted that, we need to keep a Dockerfile for the app service but rename/move it. The simplest approach: create `backend/Dockerfile` that does the same multi-stage build (frontend + backend) but without Claude CLI / subprocess dependencies that are only needed for subprocess mode.

Wait — the app container in docker-compose still needs Node.js and Claude CLI? Let me re-check... No, in container mode the app container does NOT run Claude CLI. The sidecar runs Claude CLI. The app container only needs Python + FastAPI + Docker SDK. But it does need the frontend built.

**Step 1a: Create `backend/Dockerfile` for the app service**

```dockerfile
# Stage 1: Build frontend
FROM node:20-slim AS frontend-build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/index.html frontend/vite.config.ts frontend/tsconfig.json frontend/tsconfig.app.json frontend/tsconfig.node.json ./
COPY frontend/src/ src/
RUN npm run build

# Stage 2: Python backend (no Claude CLI needed — sidecar handles agent execution)
FROM python:3.12-slim
WORKDIR /app

RUN pip install --no-cache-dir poetry && \
    poetry config virtualenvs.create false

COPY backend/pyproject.toml backend/poetry.lock ./
RUN poetry install --no-root --no-interaction --only main

COPY backend/app/ app/

# Copy built frontend into backend static directory
COPY --from=frontend-build /app/dist/ static/

RUN useradd -m appuser
USER appuser

EXPOSE 10000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "10000"]
```

Note: This is simpler than the old root Dockerfile — no Node.js or Claude CLI in the app image since the sidecar handles that.

**Step 1b: Update docker-compose.yml**

Update the `app` service build context and remove `CONTAINER_ENABLED`:

```yaml
services:
  app:
    build:
      context: .
      dockerfile: backend/Dockerfile
    # ... rest unchanged except remove CONTAINER_ENABLED from environment
```

**Step 2: Commit**

```bash
git add docker-compose.yml backend/Dockerfile
git commit -m "refactor: update docker-compose for container-only mode, add backend/Dockerfile"
```

---

### Task 6: Update `Makefile`

**Files:**
- Modify: `Makefile`

**Step 1: Update Makefile with new targets**

```makefile
.PHONY: dev backend frontend install install-backend install-frontend \
       sidecar-build sidecar-network clean compose-build compose-up compose-down

# Run both backend and frontend concurrently (requires sidecar container running)
dev:
	@trap 'kill 0' EXIT; \
	cd backend && poetry run uvicorn app.main:app --reload --port 8000 & \
	cd frontend && npm run dev & \
	wait

backend:
	cd backend && poetry run uvicorn app.main:app --reload --port 8000

frontend:
	cd frontend && npm run dev

# Install all dependencies
install: install-backend install-frontend

install-backend:
	cd backend && poetry install

install-frontend:
	cd frontend && npm install

# Sidecar setup
sidecar-build:
	docker build -t duckdb-agent-sidecar:latest ./sidecar

sidecar-network:
	./sidecar/setup-network.sh

# Docker Compose
compose-build:
	docker compose build

compose-up: sidecar-network
	docker compose up

compose-down:
	docker compose down

clean:
	rm -rf backend/.venv backend/__pycache__ backend/app/__pycache__ backend/app/routes/__pycache__
	rm -rf frontend/node_modules frontend/dist
	rm -rf sidecar/node_modules sidecar/dist
```

**Step 2: Commit**

```bash
git add Makefile
git commit -m "chore: update Makefile with sidecar-build target for dev workflow"
```

---

### Task 7: Update README

**Files:**
- Modify: `README.md`

**Step 1: Rewrite README**

Key changes:
- Remove "Deploy to Render" button and badge (line 7)
- Remove "(optional)" from container isolation everywhere
- Update Prerequisites to require Docker
- Rewrite "Getting Started" / Development for hybrid workflow:
  - Prerequisites: Node.js 20+, Python 3.12+, Poetry, Docker
  - First-time setup: `make install && make sidecar-build && make sidecar-network`
  - Dev: `make dev` (explain it requires Docker running with sidecar image built)
  - Env: `PROXY_BASE_URL=http://host.docker.internal:8000`
- Rewrite "Production Build and Deployment" to docker-compose only (remove standalone Docker build and Render sections)
- Update Security section: remove subprocess fallback language, remove `CONTAINER_ENABLED` from env var table, update credential proxy description to say "sidecar container" instead of "subprocess"
- Update Project Structure: remove deleted files, remove "(optional)" from sidecar
- Update Tech Stack: sidecar is required, not optional
- Update Features: remove "falls back to subprocess mode" language

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update README for container-only architecture"
```

---

### Task 8: Final verification

**Step 1: Run full test suite**

Run: `cd backend && poetry run pytest --tb=short -v`
Expected: All tests PASS

**Step 2: Verify docker-compose builds**

Run: `docker compose build`
Expected: Both `app` and `sidecar` images build successfully

**Step 3: Verify no stale references**

```bash
# Check for any remaining references to CONTAINER_ENABLED
grep -r "CONTAINER_ENABLED" backend/ --include="*.py"
# Should return nothing

# Check for any remaining references to tools.py
grep -r "from app.tools" backend/ --include="*.py"
# Should return nothing

# Check for any remaining references to subprocess mode
grep -r "subprocess" backend/ --include="*.py"
# Should return nothing relevant (only container_manager might mention it in comments)
```

**Step 4: Commit any fixups if needed**
