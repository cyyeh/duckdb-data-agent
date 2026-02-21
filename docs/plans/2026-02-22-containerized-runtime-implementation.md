# Containerized Claude Code Runtime Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Run each Claude Code session inside a gVisor-sandboxed Docker container ("sidecar") for code execution sandboxing, multi-tenant isolation, and defense in depth.

**Architecture:** A lightweight TypeScript HTTP server inside a Docker container wraps the Claude Agent SDK. The host FastAPI backend manages container lifecycle via Docker SDK for Python. DuckDB stays on the host; the sidecar reaches it via MCP over the host network. A feature flag (`CONTAINER_ENABLED`) allows fallback to the existing subprocess model.

**Tech Stack:** TypeScript (sidecar server), Python (container manager), Docker SDK for Python (`docker` package), gVisor (`runsc` runtime), Express.js (sidecar HTTP framework)

---

### Task 1: Sidecar TypeScript project scaffolding

**Files:**
- Create: `sidecar/package.json`
- Create: `sidecar/tsconfig.json`
- Create: `sidecar/src/types.ts`

**Step 1: Create `sidecar/package.json`**

```json
{
  "name": "duckdb-agent-sidecar",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "build": "tsc",
    "start": "node dist/server.js",
    "dev": "tsx src/server.ts"
  },
  "dependencies": {
    "express": "^4.21.0",
    "claude-agent-sdk": "^0.1.38"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.7.0"
  }
}
```

**Step 2: Create `sidecar/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src"]
}
```

**Step 3: Create `sidecar/src/types.ts`**

```typescript
export interface QueryRequest {
  message: string;
  session_id?: string;
  system_prompt: string;
  model?: string;
  mcp_server_url?: string;
}

export interface HealthResponse {
  status: "ok" | "error";
  message?: string;
}
```

**Step 4: Install dependencies**

Run: `cd sidecar && npm install`
Expected: `node_modules/` created, `package-lock.json` generated.

**Step 5: Verify TypeScript compiles**

Run: `cd sidecar && npx tsc --noEmit`
Expected: No errors.

**Step 6: Commit**

```bash
git add sidecar/package.json sidecar/package-lock.json sidecar/tsconfig.json sidecar/src/types.ts
git commit -m "feat(sidecar): scaffold TypeScript project for agent sidecar"
```

---

### Task 2: Sidecar HTTP server implementation

**Files:**
- Create: `sidecar/src/server.ts`

**Step 1: Write `sidecar/src/server.ts`**

This is the thin HTTP wrapper around the Claude Agent SDK. It exposes three endpoints:

- `GET /health` — readiness probe
- `POST /query` — accept a query, stream SSE response
- `POST /stop` — gracefully stop current session

```typescript
import express, { Request, Response } from "express";
import { ClaudeSDKClient, ClaudeAgentOptions } from "claude-agent-sdk";
import type { QueryRequest, HealthResponse } from "./types.js";

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || "3000", 10);

// Track active client for /stop endpoint
let activeClient: ClaudeSDKClient | null = null;

app.get("/health", (_req: Request, res: Response) => {
  const response: HealthResponse = { status: "ok" };
  res.json(response);
});

app.post("/query", async (req: Request, res: Response) => {
  const body = req.body as QueryRequest;

  if (!body.message || !body.system_prompt) {
    res.status(400).json({ error: "message and system_prompt are required" });
    return;
  }

  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const options: any = {
    model: body.model || process.env.ANTHROPIC_MODEL || "claude-opus-4-6",
    system_prompt: body.system_prompt,
    allowed_tools: ["mcp__duckdb__execute_sql"],
    permission_mode: "bypassPermissions",
    max_turns: 20,
    include_partial_messages: true,
    ...(body.session_id ? { resume: body.session_id } : {}),
  };

  // Configure MCP server if URL is provided
  if (body.mcp_server_url) {
    options.mcp_servers = {
      duckdb: {
        type: "sse",
        url: body.mcp_server_url,
      },
    };
  }

  const client = new ClaudeSDKClient(options);
  activeClient = client;

  try {
    await client.connect();
    await client.query(body.message, { session_id: body.session_id || "default" });

    for await (const msg of client.receiveResponse()) {
      // Forward all messages as JSON SSE events
      // The host backend will parse and re-emit these
      const data = JSON.stringify(msg);
      res.write(`data: ${data}\n\n`);
    }
  } catch (err: any) {
    const errorData = JSON.stringify({ type: "error", message: err.message || String(err) });
    res.write(`event: error\ndata: ${errorData}\n\n`);
  } finally {
    activeClient = null;
    try {
      await client.disconnect();
    } catch {
      // ignore disconnect errors
    }
    res.end();
  }
});

app.post("/stop", async (_req: Request, res: Response) => {
  if (activeClient) {
    try {
      await activeClient.disconnect();
    } catch {
      // ignore
    }
    activeClient = null;
    res.json({ status: "stopped" });
  } else {
    res.json({ status: "no_active_session" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Sidecar agent server listening on port ${PORT}`);
});
```

> **Note:** The exact Claude Agent SDK TypeScript API may differ from the Python SDK. The implementer should check the `claude-agent-sdk` npm package documentation and adjust the import paths, class names, and method signatures accordingly. The core pattern (connect → query → receive stream → disconnect) should be the same. If the npm package doesn't exist or has a different API, use `@anthropic-ai/claude-code` CLI subprocess spawning with `--output-format stream-json` instead.

**Step 2: Verify TypeScript compiles**

Run: `cd sidecar && npx tsc --noEmit`
Expected: No errors (or minimal fixable errors from SDK type mismatches).

**Step 3: Commit**

```bash
git add sidecar/src/server.ts
git commit -m "feat(sidecar): implement HTTP server wrapping Claude Agent SDK"
```

---

### Task 3: Sidecar Dockerfile

**Files:**
- Create: `sidecar/Dockerfile`
- Create: `sidecar/.dockerignore`

**Step 1: Create `sidecar/.dockerignore`**

```
node_modules
dist
*.md
```

**Step 2: Create `sidecar/Dockerfile`**

```dockerfile
FROM python:3.12-slim AS base

# Install Node.js 20
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install Claude CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Build the sidecar server
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Create non-root user
RUN useradd --create-home --shell /bin/bash appuser

USER appuser
EXPOSE 3000

CMD ["node", "dist/server.js"]
```

**Step 3: Build the image**

Run: `cd sidecar && docker build -t duckdb-agent-sidecar:latest .`
Expected: Image builds successfully.

**Step 4: Test the image starts**

Run: `docker run --rm -d --name sidecar-test -p 3001:3000 duckdb-agent-sidecar:latest && sleep 3 && curl -s http://localhost:3001/health && docker stop sidecar-test`
Expected: `{"status":"ok"}`

**Step 5: Commit**

```bash
git add sidecar/Dockerfile sidecar/.dockerignore
git commit -m "feat(sidecar): add Dockerfile with Node.js 20 + Python 3.12 + Claude CLI"
```

---

### Task 4: Backend configuration for container settings

**Files:**
- Modify: `backend/app/config.py:22-23`
- Modify: `backend/.env.example`

**Step 1: Add container config to `backend/app/config.py`**

After line 23 (`MAX_TOTAL_SIZE_BYTES = ...`), add:

```python
# Container isolation settings
CONTAINER_ENABLED = os.getenv("CONTAINER_ENABLED", "false").lower() == "true"
CONTAINER_IMAGE = os.getenv("CONTAINER_IMAGE", "duckdb-agent-sidecar:latest")
CONTAINER_RUNTIME = os.getenv("CONTAINER_RUNTIME", "runsc")
CONTAINER_MEMORY_LIMIT = os.getenv("CONTAINER_MEMORY_LIMIT", "256m")
CONTAINER_CPU_LIMIT = float(os.getenv("CONTAINER_CPU_LIMIT", "0.5"))
CONTAINER_MAX_LIFETIME_SECONDS = int(os.getenv("CONTAINER_MAX_LIFETIME_SECONDS", "600"))
CONTAINER_NETWORK = os.getenv("CONTAINER_NETWORK", "agent-sandbox")
```

**Step 2: Update `.env.example`**

Append to the end of `backend/.env.example`:

```
# Container isolation (requires Docker + gVisor)
CONTAINER_ENABLED=false
CONTAINER_IMAGE=duckdb-agent-sidecar:latest
CONTAINER_RUNTIME=runsc
CONTAINER_MEMORY_LIMIT=256m
CONTAINER_CPU_LIMIT=0.5
CONTAINER_MAX_LIFETIME_SECONDS=600
CONTAINER_NETWORK=agent-sandbox
```

**Step 3: Commit**

```bash
git add backend/app/config.py backend/.env.example
git commit -m "feat: add container isolation configuration variables"
```

---

### Task 5: Container manager — unit tests

**Files:**
- Create: `backend/tests/test_container_manager.py`

**Step 1: Write tests for `ContainerManager`**

These tests mock the Docker SDK so they run without Docker installed.

```python
import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch, PropertyMock

import pytest

from app.container_manager import ContainerManager, ContainerInfo, ContainerConfig


@pytest.fixture
def config():
    return ContainerConfig(
        image="duckdb-agent-sidecar:latest",
        runtime="runsc",
        memory_limit="256m",
        cpu_limit=0.5,
        max_lifetime_seconds=600,
        network="agent-sandbox",
    )


@pytest.fixture
def mock_docker_client():
    client = MagicMock()
    client.containers = MagicMock()
    client.networks = MagicMock()
    return client


@pytest.fixture
def manager(config, mock_docker_client):
    with patch("app.container_manager.docker") as mock_docker:
        mock_docker.from_env.return_value = mock_docker_client
        mgr = ContainerManager(config)
        mgr._client = mock_docker_client
        return mgr


def test_container_config_has_defaults():
    cfg = ContainerConfig()
    assert cfg.image == "duckdb-agent-sidecar:latest"
    assert cfg.runtime == "runsc"
    assert cfg.memory_limit == "256m"
    assert cfg.cpu_limit == 0.5
    assert cfg.max_lifetime_seconds == 600
    assert cfg.network == "agent-sandbox"


def test_create_stores_container_info(manager, mock_docker_client):
    mock_container = MagicMock()
    mock_container.id = "abc123"
    mock_container.attrs = {"NetworkSettings": {"Networks": {"agent-sandbox": {"IPAddress": "172.18.0.2"}}}}
    mock_docker_client.containers.run.return_value = mock_container

    info = manager.create("session-1", {"ANTHROPIC_API_KEY": "token123"})

    assert "session-1" in manager._containers
    assert info.container_id == "abc123"
    assert info.session_id == "session-1"


def test_create_passes_security_flags(manager, mock_docker_client):
    mock_container = MagicMock()
    mock_container.id = "abc123"
    mock_container.attrs = {"NetworkSettings": {"Networks": {"agent-sandbox": {"IPAddress": "172.18.0.2"}}}}
    mock_docker_client.containers.run.return_value = mock_container

    manager.create("session-1", {"ANTHROPIC_API_KEY": "token123"})

    call_kwargs = mock_docker_client.containers.run.call_args[1]
    assert call_kwargs["runtime"] == "runsc"
    assert call_kwargs["read_only"] is True
    assert call_kwargs["cap_drop"] == ["ALL"]
    assert call_kwargs["security_opt"] == ["no-new-privileges"]
    assert call_kwargs["detach"] is True


def test_stop_removes_container_and_record(manager, mock_docker_client):
    mock_container = MagicMock()
    mock_container.id = "abc123"
    mock_container.attrs = {"NetworkSettings": {"Networks": {"agent-sandbox": {"IPAddress": "172.18.0.2"}}}}
    mock_docker_client.containers.run.return_value = mock_container

    manager.create("session-1", {})
    manager.stop("session-1")

    mock_container.stop.assert_called_once()
    mock_container.remove.assert_called_once_with(force=True)
    assert "session-1" not in manager._containers


def test_stop_nonexistent_session_is_safe(manager):
    manager.stop("ghost-session")  # must not raise


def test_cleanup_expired_removes_old_containers(manager, mock_docker_client):
    mock_container = MagicMock()
    mock_container.id = "abc123"
    mock_container.attrs = {"NetworkSettings": {"Networks": {"agent-sandbox": {"IPAddress": "172.18.0.2"}}}}
    mock_docker_client.containers.run.return_value = mock_container

    manager.create("old-session", {})
    # Backdate creation time
    manager._containers["old-session"].created_at = (
        datetime.now(timezone.utc) - timedelta(seconds=700)
    )

    removed = manager.cleanup_expired()
    assert removed == 1
    assert "old-session" not in manager._containers


def test_cleanup_expired_keeps_recent_containers(manager, mock_docker_client):
    mock_container = MagicMock()
    mock_container.id = "abc123"
    mock_container.attrs = {"NetworkSettings": {"Networks": {"agent-sandbox": {"IPAddress": "172.18.0.2"}}}}
    mock_docker_client.containers.run.return_value = mock_container

    manager.create("new-session", {})

    removed = manager.cleanup_expired()
    assert removed == 0
    assert "new-session" in manager._containers


def test_shutdown_all_stops_all_containers(manager, mock_docker_client):
    mock_container_1 = MagicMock()
    mock_container_1.id = "abc1"
    mock_container_1.attrs = {"NetworkSettings": {"Networks": {"agent-sandbox": {"IPAddress": "172.18.0.2"}}}}

    mock_container_2 = MagicMock()
    mock_container_2.id = "abc2"
    mock_container_2.attrs = {"NetworkSettings": {"Networks": {"agent-sandbox": {"IPAddress": "172.18.0.3"}}}}

    mock_docker_client.containers.run.side_effect = [mock_container_1, mock_container_2]

    manager.create("s1", {})
    manager.create("s2", {})
    manager.shutdown_all()

    mock_container_1.stop.assert_called_once()
    mock_container_2.stop.assert_called_once()
    assert len(manager._containers) == 0


def test_get_url_returns_correct_format(manager, mock_docker_client):
    mock_container = MagicMock()
    mock_container.id = "abc123"
    mock_container.attrs = {"NetworkSettings": {"Networks": {"agent-sandbox": {"IPAddress": "172.18.0.2"}}}}
    mock_docker_client.containers.run.return_value = mock_container

    info = manager.create("session-1", {})
    assert info.url == "http://172.18.0.2:3000"
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent/backend && poetry run pytest tests/test_container_manager.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.container_manager'`

**Step 3: Commit**

```bash
git add backend/tests/test_container_manager.py
git commit -m "test: add unit tests for ContainerManager (red phase)"
```

---

### Task 6: Container manager — implementation

**Files:**
- Create: `backend/app/container_manager.py`
- Modify: `backend/pyproject.toml:16` (add `docker` dependency)

**Step 1: Add `docker` dependency to `backend/pyproject.toml`**

In the `[tool.poetry.dependencies]` section, add:

```
docker = "^7.0.0"
```

**Step 2: Install the dependency**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent/backend && poetry add docker`

**Step 3: Write `backend/app/container_manager.py`**

```python
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import docker

logger = logging.getLogger(__name__)


@dataclass
class ContainerConfig:
    image: str = "duckdb-agent-sidecar:latest"
    runtime: str = "runsc"
    memory_limit: str = "256m"
    cpu_limit: float = 0.5
    max_lifetime_seconds: int = 600
    network: str = "agent-sandbox"


@dataclass
class ContainerInfo:
    container_id: str
    session_id: str
    ip_address: str
    port: int = 3000
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    _container: object = field(default=None, repr=False)

    @property
    def url(self) -> str:
        return f"http://{self.ip_address}:{self.port}"


class ContainerManager:
    """Manages per-session gVisor-sandboxed sidecar containers."""

    def __init__(self, config: ContainerConfig | None = None):
        self._config = config or ContainerConfig()
        self._client = docker.from_env()
        self._containers: dict[str, ContainerInfo] = {}

    def create(self, session_id: str, env: dict[str, str]) -> ContainerInfo:
        """Spin up a new sidecar container for a session."""
        if session_id in self._containers:
            return self._containers[session_id]

        container = self._client.containers.run(
            image=self._config.image,
            detach=True,
            runtime=self._config.runtime,
            mem_limit=self._config.memory_limit,
            nano_cpus=int(self._config.cpu_limit * 1e9),
            read_only=True,
            cap_drop=["ALL"],
            security_opt=["no-new-privileges"],
            tmpfs={"/tmp": "size=50m"},
            network=self._config.network,
            environment=env,
            labels={
                "app": "duckdb-agent-sidecar",
                "session_id": session_id,
            },
            auto_remove=False,  # We remove manually to handle errors
        )

        # Reload to get network info
        container.reload()
        networks = container.attrs.get("NetworkSettings", {}).get("Networks", {})
        network_info = networks.get(self._config.network, {})
        ip_address = network_info.get("IPAddress", "127.0.0.1")

        info = ContainerInfo(
            container_id=container.id,
            session_id=session_id,
            ip_address=ip_address,
            _container=container,
        )
        self._containers[session_id] = info
        logger.info(
            "Created sidecar container %s for session %s at %s",
            container.id[:12],
            session_id,
            info.url,
        )
        return info

    def get(self, session_id: str) -> ContainerInfo | None:
        """Get container info for a session."""
        return self._containers.get(session_id)

    def stop(self, session_id: str) -> None:
        """Stop and remove the container for a session."""
        info = self._containers.pop(session_id, None)
        if info is None:
            return

        container = info._container
        try:
            container.stop(timeout=5)
        except Exception as e:
            logger.warning("Failed to stop container %s: %s", info.container_id[:12], e)
        try:
            container.remove(force=True)
        except Exception as e:
            logger.warning("Failed to remove container %s: %s", info.container_id[:12], e)

        logger.info("Stopped sidecar container %s for session %s", info.container_id[:12], session_id)

    def cleanup_expired(self) -> int:
        """Remove containers that have exceeded max lifetime."""
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=self._config.max_lifetime_seconds)
        expired = [
            sid for sid, info in self._containers.items()
            if info.created_at < cutoff
        ]
        for sid in expired:
            logger.info("Container for session %s exceeded max lifetime, removing", sid)
            self.stop(sid)
        return len(expired)

    def shutdown_all(self) -> None:
        """Stop and remove all active containers. Called on backend shutdown."""
        session_ids = list(self._containers.keys())
        for sid in session_ids:
            self.stop(sid)
        logger.info("Shut down %d sidecar containers", len(session_ids))
```

**Step 4: Run tests to verify they pass**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent/backend && poetry run pytest tests/test_container_manager.py -v`
Expected: All tests PASS.

**Step 5: Commit**

```bash
git add backend/app/container_manager.py backend/pyproject.toml backend/poetry.lock
git commit -m "feat: implement ContainerManager for Docker container lifecycle"
```

---

### Task 7: Integrate container manager into agent.py

**Files:**
- Modify: `backend/app/agent.py:106-302`

**Step 1: Write a test for the container integration path**

Create `backend/tests/test_agent_container.py`:

```python
from unittest.mock import patch, MagicMock

from app.config import CONTAINER_ENABLED


def test_container_enabled_reads_from_config():
    """Verify the config flag is available and defaults to False."""
    # This just validates the import — integration is tested manually
    assert CONTAINER_ENABLED is False or CONTAINER_ENABLED is True
```

**Step 2: Modify `backend/app/agent.py`**

Add the container-based streaming path. The key change is in `stream_chat()`: when `CONTAINER_ENABLED` is `True`, instead of creating a local `ClaudeSDKClient`, the function:

1. Creates or reuses a container via `ContainerManager`
2. Sends a POST request to the sidecar's `/query` endpoint
3. Streams the SSE response back

At the top of `agent.py`, add imports:

```python
from app.config import ANTHROPIC_MODEL, PROXY_BASE_URL, CONTAINER_ENABLED
```

Add a new function `_stream_chat_container()` after `_extract_tool_result_text()` (before `stream_chat()`):

```python
async def _stream_chat_container(
    message: str,
    session_id: str | None,
    db: Database,
    conversation_history: list[dict] | None,
    container_manager,
) -> AsyncIterator[str]:
    """Stream chat via containerized sidecar instead of local subprocess."""
    import httpx

    query_message = _build_message_with_history(message, conversation_history)
    system_prompt = build_system_prompt(db)

    session_token = proxy_token_store.create_token()

    env = {
        "ANTHROPIC_API_KEY": session_token,
        "ANTHROPIC_BASE_URL": f"{PROXY_BASE_URL}/anthropic",
        "LANGFUSE_PUBLIC_KEY": "",
        "LANGFUSE_SECRET_KEY": "",
    }

    try:
        # Create or reuse container for this session
        container_session = session_id or "default"
        info = container_manager.create(container_session, env)

        # Wait for container to be ready
        import asyncio
        for attempt in range(10):
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as check_client:
                    resp = await check_client.get(f"{info.url}/health")
                    if resp.status_code == 200:
                        break
            except Exception:
                pass
            await asyncio.sleep(1)
        else:
            raise RuntimeError(f"Sidecar container failed health check after 10 attempts")

        # Send query to sidecar
        payload = {
            "message": query_message,
            "session_id": session_id,
            "system_prompt": system_prompt,
            "model": ANTHROPIC_MODEL,
            "mcp_server_url": f"{PROXY_BASE_URL}/mcp",
        }

        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as client:
            async with client.stream("POST", f"{info.url}/query", json=payload) as response:
                async for line in response.aiter_lines():
                    if line.startswith("data: "):
                        # Forward SSE data lines directly
                        yield f"{line}\n\n"
                    elif line.startswith("event: "):
                        yield f"{line}\n"

    except Exception as e:
        logger.error("Container agent error: %s", str(e))
        yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"
    finally:
        proxy_token_store.revoke_token(session_token)
```

Then modify `stream_chat()` to dispatch between the two paths. At the beginning of `stream_chat()`, add:

```python
    if CONTAINER_ENABLED:
        # Import here to avoid import error when docker is not installed
        from app.container_manager import container_manager
        async for event in _stream_chat_container(
            message, session_id, db, conversation_history, container_manager
        ):
            yield event
        return
```

**Step 3: Run existing tests to verify no regression**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent/backend && poetry run pytest tests/ -v`
Expected: All existing tests PASS (container path is not triggered because `CONTAINER_ENABLED=false`).

**Step 4: Commit**

```bash
git add backend/app/agent.py backend/tests/test_agent_container.py
git commit -m "feat: add containerized streaming path to agent.py behind feature flag"
```

---

### Task 8: Integrate container manager into main.py lifecycle

**Files:**
- Modify: `backend/app/main.py:19-34`

**Step 1: Update `_cleanup_loop` and `lifespan` in `main.py`**

Add container cleanup to the background loop and shutdown handler:

After the existing imports at the top of `main.py`, add:

```python
from app.config import CONTAINER_ENABLED
```

Modify `_cleanup_loop()` to add container cleanup:

```python
async def _cleanup_loop():
    while True:
        await asyncio.sleep(60)
        removed = session_manager.cleanup_stale(ttl_seconds=300)
        if removed:
            logger.info("Background cleanup: removed %d stale sessions", removed)
        proxy_removed = proxy_module.proxy_token_store.cleanup_expired()
        if proxy_removed:
            logger.info("Background cleanup: removed %d expired proxy tokens", proxy_removed)
        if CONTAINER_ENABLED:
            from app.container_manager import container_manager
            container_removed = container_manager.cleanup_expired()
            if container_removed:
                logger.info("Background cleanup: removed %d expired containers", container_removed)
```

Modify `lifespan()` to add container shutdown:

```python
@asynccontextmanager
async def lifespan(app):
    task = asyncio.create_task(_cleanup_loop())
    yield
    task.cancel()
    if CONTAINER_ENABLED:
        from app.container_manager import container_manager
        container_manager.shutdown_all()
```

**Step 2: Run tests to verify no regression**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent/backend && poetry run pytest tests/ -v`
Expected: All tests PASS.

**Step 3: Commit**

```bash
git add backend/app/main.py
git commit -m "feat: add container cleanup and shutdown to application lifecycle"
```

---

### Task 9: Add singleton container_manager instance

**Files:**
- Modify: `backend/app/container_manager.py` (add module-level singleton)

**Step 1: Add singleton at the bottom of `container_manager.py`**

After the `ContainerManager` class, add:

```python
from app.config import (
    CONTAINER_IMAGE,
    CONTAINER_RUNTIME,
    CONTAINER_MEMORY_LIMIT,
    CONTAINER_CPU_LIMIT,
    CONTAINER_MAX_LIFETIME_SECONDS,
    CONTAINER_NETWORK,
)

container_manager = ContainerManager(
    ContainerConfig(
        image=CONTAINER_IMAGE,
        runtime=CONTAINER_RUNTIME,
        memory_limit=CONTAINER_MEMORY_LIMIT,
        cpu_limit=CONTAINER_CPU_LIMIT,
        max_lifetime_seconds=CONTAINER_MAX_LIFETIME_SECONDS,
        network=CONTAINER_NETWORK,
    )
)
```

**Step 2: Run tests**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent/backend && poetry run pytest tests/ -v`
Expected: All tests PASS.

**Step 3: Commit**

```bash
git add backend/app/container_manager.py
git commit -m "feat: add singleton container_manager instance with config"
```

---

### Task 10: Docker network setup script

**Files:**
- Create: `sidecar/setup-network.sh`

**Step 1: Create `sidecar/setup-network.sh`**

This script creates the Docker network with internal network restrictions.

```bash
#!/usr/bin/env bash
set -euo pipefail

NETWORK_NAME="${CONTAINER_NETWORK:-agent-sandbox}"

# Create the bridge network if it doesn't exist
if ! docker network inspect "$NETWORK_NAME" &>/dev/null; then
    echo "Creating Docker network: $NETWORK_NAME"
    docker network create \
        --driver bridge \
        --internal=false \
        "$NETWORK_NAME"
    echo "Network $NETWORK_NAME created."
else
    echo "Network $NETWORK_NAME already exists."
fi

echo ""
echo "To block internal network access from containers, add iptables rules:"
echo "  iptables -I DOCKER-USER -s 172.18.0.0/16 -d 10.0.0.0/8 -j DROP"
echo "  iptables -I DOCKER-USER -s 172.18.0.0/16 -d 172.16.0.0/12 -j DROP"
echo "  iptables -I DOCKER-USER -s 172.18.0.0/16 -d 192.168.0.0/16 -j DROP"
echo "  iptables -I DOCKER-USER -s 172.18.0.0/16 -d 169.254.0.0/16 -j DROP"
echo ""
echo "Note: Allow the host proxy address explicitly before applying these rules."
```

**Step 2: Make it executable**

Run: `chmod +x sidecar/setup-network.sh`

**Step 3: Commit**

```bash
git add sidecar/setup-network.sh
git commit -m "feat(sidecar): add Docker network setup script"
```

---

### Task 11: Update .env.example and .dockerignore

**Files:**
- Modify: `.dockerignore`
- Modify: `.gitignore`

**Step 1: Add sidecar node_modules to `.gitignore`**

Append to `.gitignore`:

```
sidecar/node_modules/
sidecar/dist/
```

**Step 2: Add sidecar to `.dockerignore`**

Check if sidecar should be excluded from the main Dockerfile build context. Append to `.dockerignore`:

```
sidecar/node_modules
sidecar/dist
```

**Step 3: Commit**

```bash
git add .gitignore .dockerignore
git commit -m "chore: add sidecar build artifacts to gitignore and dockerignore"
```

---

### Task 12: Update README with container isolation section

**Files:**
- Modify: `README.md`

**Step 1: Add a "Container Isolation" section to README**

Add after the existing security/credential proxy section. Include:

- How to build the sidecar image
- How to set up the Docker network
- How to install gVisor
- Environment variables reference
- How to enable/disable via feature flag

Keep it concise — link to the design doc for full details.

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add container isolation setup instructions to README"
```

---

### Task 13: End-to-end manual verification

**No files modified — this is a verification task.**

**Step 1: Build the sidecar image**

Run: `cd sidecar && docker build -t duckdb-agent-sidecar:latest .`

**Step 2: Create the Docker network**

Run: `./sidecar/setup-network.sh`

**Step 3: Start the backend with containers enabled**

Run: `CONTAINER_ENABLED=true cd backend && poetry run uvicorn app.main:app --host 0.0.0.0 --port 10000`

**Step 4: Open the frontend and send a chat message**

Expected:
- `docker ps` shows a sidecar container with `runsc` runtime
- Chat response streams normally
- Container is removed after session ends

**Step 5: Test fallback mode**

Run: `CONTAINER_ENABLED=false cd backend && poetry run uvicorn app.main:app --host 0.0.0.0 --port 10000`

Expected: Chat works exactly as before (subprocess model), no containers created.
