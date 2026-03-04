# OpenSandbox Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the custom `ContainerManager` with OpenSandbox for container lifecycle management, supporting both Docker and Kubernetes runtimes.

**Architecture:** The backend uses the OpenSandbox Python SDK to create/manage sidecar containers. An OpenSandbox server runs as a separate docker-compose service (Docker mode) or K8s deployment (K8s mode). The sidecar image and `/query` communication remain unchanged.

**Tech Stack:** OpenSandbox SDK (`opensandbox` pip package), OpenSandbox Server (`opensandbox-server`), Helm, Kustomize, Kubernetes Python client

---

### Task 1: Add OpenSandbox dependencies

**Files:**
- Modify: `backend/pyproject.toml` (add `opensandbox` dependency)

**Step 1: Add opensandbox to pyproject.toml**

In `backend/pyproject.toml`, add `opensandbox` to the `[project.dependencies]` list (or `[tool.poetry.dependencies]` depending on the format):

```toml
opensandbox = ">=1.0.0"
```

**Step 2: Install dependencies**

Run: `cd backend && pip install -e .` (or `poetry install` / `uv pip install -e .` depending on the project's package manager)
Expected: installs successfully, `opensandbox` package available

**Step 3: Verify import works**

Run: `cd backend && python -c "from opensandbox import Sandbox; print('OK')"`
Expected: prints "OK"

**Step 4: Commit**

```bash
git add backend/pyproject.toml
git commit -m "chore: add opensandbox dependency"
```

---

### Task 2: Add OpenSandbox config variables

**Files:**
- Modify: `backend/app/config.py:50-58`

**Step 1: Write the failing test**

Create `backend/tests/test_opensandbox_config.py`:

```python
import os
import importlib


def test_sandbox_runtime_defaults_to_docker(monkeypatch):
    """SANDBOX_RUNTIME should default to 'docker'."""
    monkeypatch.delenv("SANDBOX_RUNTIME", raising=False)
    import app.config
    importlib.reload(app.config)
    assert app.config.SANDBOX_RUNTIME == "docker"


def test_sandbox_runtime_reads_env(monkeypatch):
    """SANDBOX_RUNTIME should read from environment."""
    monkeypatch.setenv("SANDBOX_RUNTIME", "kubernetes")
    import app.config
    importlib.reload(app.config)
    assert app.config.SANDBOX_RUNTIME == "kubernetes"


def test_opensandbox_domain_default(monkeypatch):
    monkeypatch.delenv("OPENSANDBOX_DOMAIN", raising=False)
    import app.config
    importlib.reload(app.config)
    assert app.config.OPENSANDBOX_DOMAIN == "localhost:8080"


def test_k8s_namespace_default(monkeypatch):
    monkeypatch.delenv("K8S_NAMESPACE", raising=False)
    import app.config
    importlib.reload(app.config)
    assert app.config.K8S_NAMESPACE == "default"
```

**Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_opensandbox_config.py -v`
Expected: FAIL with `AttributeError: module 'app.config' has no attribute 'SANDBOX_RUNTIME'`

**Step 3: Add config variables to config.py**

In `backend/app/config.py`, after the existing container isolation settings block (line 58), add:

```python
# OpenSandbox settings
SANDBOX_RUNTIME = os.getenv("SANDBOX_RUNTIME", "docker")  # "docker" or "kubernetes"
OPENSANDBOX_DOMAIN = os.getenv("OPENSANDBOX_DOMAIN", "localhost:8080")
OPENSANDBOX_API_KEY = os.getenv("OPENSANDBOX_API_KEY", "")
# Kubernetes-specific
K8S_NAMESPACE = os.getenv("K8S_NAMESPACE", "default")
K8S_WORKLOAD_PROVIDER = os.getenv("K8S_WORKLOAD_PROVIDER", "agent-sandbox")
```

**Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_opensandbox_config.py -v`
Expected: PASS (all 4 tests)

**Step 5: Commit**

```bash
git add backend/app/config.py backend/tests/test_opensandbox_config.py
git commit -m "feat: add OpenSandbox configuration variables"
```

---

### Task 3: Create SandboxManager with same interface as ContainerManager

**Files:**
- Create: `backend/app/sandbox_manager.py`
- Test: `backend/tests/test_sandbox_manager.py`

**Step 1: Write the failing tests**

Create `backend/tests/test_sandbox_manager.py`:

```python
"""Tests for SandboxManager — OpenSandbox-based container lifecycle."""
import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.sandbox_manager import SandboxManager, SandboxConfig, SandboxInfo


@pytest.fixture
def config():
    return SandboxConfig(
        image="duckdb-agent-sidecar:latest",
        memory_limit="256m",
        cpu_limit=0.5,
        max_lifetime_seconds=3600,
        idle_timeout_seconds=300,
        opensandbox_domain="localhost:8080",
    )


@pytest.fixture
def manager(config):
    return SandboxManager(config)


class TestSandboxConfig:
    def test_defaults(self):
        cfg = SandboxConfig()
        assert cfg.image == "duckdb-agent-sidecar:latest"
        assert cfg.memory_limit == "512m"
        assert cfg.cpu_limit == 0.5
        assert cfg.opensandbox_domain == "localhost:8080"

    def test_resource_dict(self):
        cfg = SandboxConfig(memory_limit="1Gi", cpu_limit=2.0)
        res = cfg.resource_dict()
        assert res == {"cpu": "2", "memory": "1Gi"}

    def test_resource_dict_fractional_cpu(self):
        cfg = SandboxConfig(cpu_limit=0.5)
        res = cfg.resource_dict()
        assert res == {"cpu": "0.5", "memory": "512m"}


class TestSandboxManagerCreate:
    @pytest.mark.asyncio
    async def test_create_returns_sandbox_info(self, manager):
        mock_sandbox = AsyncMock()
        mock_sandbox.id = "sandbox-123"

        mock_endpoint = MagicMock()
        mock_endpoint.endpoint = "192.168.1.100:3000"
        mock_endpoint.headers = {}
        mock_sandbox.get_endpoint = AsyncMock(return_value=mock_endpoint)

        with patch("app.sandbox_manager.Sandbox") as MockSandbox:
            MockSandbox.create = AsyncMock(return_value=mock_sandbox)

            info = await manager.create("session-1", {"KEY": "value"})

            assert info.sandbox_id == "sandbox-123"
            assert info.session_id == "session-1"
            assert info.url == "http://192.168.1.100:3000"
            MockSandbox.create.assert_called_once()

    @pytest.mark.asyncio
    async def test_create_reuses_existing(self, manager):
        mock_sandbox = AsyncMock()
        mock_sandbox.id = "sandbox-123"
        mock_endpoint = MagicMock()
        mock_endpoint.endpoint = "192.168.1.100:3000"
        mock_endpoint.headers = {}
        mock_sandbox.get_endpoint = AsyncMock(return_value=mock_endpoint)

        with patch("app.sandbox_manager.Sandbox") as MockSandbox:
            MockSandbox.create = AsyncMock(return_value=mock_sandbox)
            info1 = await manager.create("session-1", {"KEY": "value"})
            info2 = await manager.create("session-1", {"KEY": "value"})
            assert info1 is info2
            assert MockSandbox.create.call_count == 1


class TestSandboxManagerGet:
    @pytest.mark.asyncio
    async def test_get_returns_none_when_missing(self, manager):
        assert manager.get("nonexistent") is None

    @pytest.mark.asyncio
    async def test_get_returns_info_after_create(self, manager):
        mock_sandbox = AsyncMock()
        mock_sandbox.id = "sandbox-123"
        mock_endpoint = MagicMock()
        mock_endpoint.endpoint = "192.168.1.100:3000"
        mock_endpoint.headers = {}
        mock_sandbox.get_endpoint = AsyncMock(return_value=mock_endpoint)

        with patch("app.sandbox_manager.Sandbox") as MockSandbox:
            MockSandbox.create = AsyncMock(return_value=mock_sandbox)
            await manager.create("session-1", {})
            info = manager.get("session-1")
            assert info is not None
            assert info.session_id == "session-1"


class TestSandboxManagerTouch:
    @pytest.mark.asyncio
    async def test_touch_updates_last_activity(self, manager):
        mock_sandbox = AsyncMock()
        mock_sandbox.id = "sandbox-123"
        mock_endpoint = MagicMock()
        mock_endpoint.endpoint = "192.168.1.100:3000"
        mock_endpoint.headers = {}
        mock_sandbox.get_endpoint = AsyncMock(return_value=mock_endpoint)

        with patch("app.sandbox_manager.Sandbox") as MockSandbox:
            MockSandbox.create = AsyncMock(return_value=mock_sandbox)
            await manager.create("session-1", {})
            before = manager.get("session-1").last_activity
            await asyncio.sleep(0.01)
            manager.touch("session-1")
            after = manager.get("session-1").last_activity
            assert after > before


class TestSandboxManagerStop:
    @pytest.mark.asyncio
    async def test_stop_kills_sandbox_and_removes(self, manager):
        mock_sandbox = AsyncMock()
        mock_sandbox.id = "sandbox-123"
        mock_sandbox.kill = AsyncMock()
        mock_endpoint = MagicMock()
        mock_endpoint.endpoint = "192.168.1.100:3000"
        mock_endpoint.headers = {}
        mock_sandbox.get_endpoint = AsyncMock(return_value=mock_endpoint)

        with patch("app.sandbox_manager.Sandbox") as MockSandbox:
            MockSandbox.create = AsyncMock(return_value=mock_sandbox)
            await manager.create("session-1", {})
            await manager.stop("session-1")
            mock_sandbox.kill.assert_called_once()
            assert manager.get("session-1") is None


class TestSandboxManagerCleanup:
    @pytest.mark.asyncio
    async def test_cleanup_expired_removes_idle(self, manager):
        mock_sandbox = AsyncMock()
        mock_sandbox.id = "sandbox-123"
        mock_sandbox.kill = AsyncMock()
        mock_endpoint = MagicMock()
        mock_endpoint.endpoint = "192.168.1.100:3000"
        mock_endpoint.headers = {}
        mock_sandbox.get_endpoint = AsyncMock(return_value=mock_endpoint)

        with patch("app.sandbox_manager.Sandbox") as MockSandbox:
            MockSandbox.create = AsyncMock(return_value=mock_sandbox)
            await manager.create("session-1", {})

            # Backdate last_activity so it's past idle timeout
            info = manager.get("session-1")
            info.last_activity = datetime.now(timezone.utc) - timedelta(seconds=400)

            removed = await manager.cleanup_expired()
            assert removed == 1
            assert manager.get("session-1") is None


class TestSandboxManagerShutdownAll:
    @pytest.mark.asyncio
    async def test_shutdown_all_kills_all(self, manager):
        mock_sandbox1 = AsyncMock()
        mock_sandbox1.id = "sandbox-1"
        mock_sandbox1.kill = AsyncMock()
        mock_sandbox2 = AsyncMock()
        mock_sandbox2.id = "sandbox-2"
        mock_sandbox2.kill = AsyncMock()

        mock_endpoint = MagicMock()
        mock_endpoint.endpoint = "192.168.1.100:3000"
        mock_endpoint.headers = {}

        sandbox_iter = iter([mock_sandbox1, mock_sandbox2])

        with patch("app.sandbox_manager.Sandbox") as MockSandbox:
            MockSandbox.create = AsyncMock(side_effect=lambda *a, **kw: next(sandbox_iter))
            for sb in [mock_sandbox1, mock_sandbox2]:
                sb.get_endpoint = AsyncMock(return_value=mock_endpoint)
            await manager.create("session-1", {})
            await manager.create("session-2", {})

            await manager.shutdown_all()

            mock_sandbox1.kill.assert_called_once()
            mock_sandbox2.kill.assert_called_once()
```

**Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_sandbox_manager.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.sandbox_manager'`

**Step 3: Write the SandboxManager implementation**

Create `backend/app/sandbox_manager.py`:

```python
"""OpenSandbox-based container lifecycle management.

Replaces the direct Docker SDK ContainerManager with the OpenSandbox SDK.
Supports both Docker and Kubernetes runtimes via OpenSandbox server.
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from opensandbox import Sandbox, SandboxManager as OSManager
from opensandbox.config import ConnectionConfig
from opensandbox.models.sandboxes import SandboxFilter

logger = logging.getLogger(__name__)


@dataclass
class SandboxConfig:
    image: str = "duckdb-agent-sidecar:latest"
    memory_limit: str = "512m"
    cpu_limit: float = 0.5
    max_lifetime_seconds: int = 3600
    idle_timeout_seconds: int = 300
    sidecar_port: int = 3000
    opensandbox_domain: str = "localhost:8080"
    opensandbox_api_key: str = ""

    def resource_dict(self) -> dict[str, str]:
        """Return resource limits in OpenSandbox format."""
        cpu_str = str(int(self.cpu_limit)) if self.cpu_limit == int(self.cpu_limit) else str(self.cpu_limit)
        return {"cpu": cpu_str, "memory": self.memory_limit}


@dataclass
class SandboxInfo:
    sandbox_id: str
    session_id: str
    endpoint: str  # "host:port"
    endpoint_headers: dict[str, str] = field(default_factory=dict)
    port: int = 3000
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    last_activity: datetime = field(default=None)
    _sandbox: object = field(default=None, repr=False)

    def __post_init__(self):
        if self.last_activity is None:
            self.last_activity = self.created_at

    @property
    def url(self) -> str:
        return f"http://{self.endpoint}"


class SandboxManager:
    """Manages per-session sidecar containers via OpenSandbox."""

    def __init__(self, config: SandboxConfig | None = None):
        self._config = config or SandboxConfig()
        self._connection_config = ConnectionConfig(
            domain=self._config.opensandbox_domain,
            api_key=self._config.opensandbox_api_key or None,
            request_timeout=timedelta(seconds=60),
        )
        self._sandboxes: dict[str, SandboxInfo] = {}

    async def create(self, session_id: str, env: dict[str, str]) -> SandboxInfo:
        """Create a new sidecar sandbox for a session."""
        if session_id in self._sandboxes:
            return self._sandboxes[session_id]

        sandbox = await Sandbox.create(
            self._config.image,
            connection_config=self._connection_config,
            timeout=timedelta(seconds=self._config.max_lifetime_seconds),
            env=env,
            metadata={
                "app": "duckdb-agent-sidecar",
                "session_id": session_id,
            },
            resource=self._config.resource_dict(),
            skip_health_check=True,
        )

        endpoint = await sandbox.get_endpoint(self._config.sidecar_port)

        info = SandboxInfo(
            sandbox_id=sandbox.id,
            session_id=session_id,
            endpoint=endpoint.endpoint,
            endpoint_headers=endpoint.headers or {},
            port=self._config.sidecar_port,
            _sandbox=sandbox,
        )
        self._sandboxes[session_id] = info
        logger.info(
            "Created sandbox %s for session %s at %s",
            sandbox.id[:12],
            session_id,
            info.url,
        )
        return info

    def get(self, session_id: str) -> SandboxInfo | None:
        """Get sandbox info for a session."""
        return self._sandboxes.get(session_id)

    def touch(self, session_id: str) -> None:
        """Update last_activity timestamp for a session's sandbox."""
        info = self._sandboxes.get(session_id)
        if info is not None:
            info.last_activity = datetime.now(timezone.utc)

    async def stop(self, session_id: str) -> None:
        """Kill and remove the sandbox for a session."""
        info = self._sandboxes.pop(session_id, None)
        if info is None:
            return

        sandbox = info._sandbox
        try:
            await sandbox.kill()
        except Exception as e:
            logger.warning("Failed to kill sandbox %s: %s", info.sandbox_id[:12], e)

        logger.info("Stopped sandbox %s for session %s", info.sandbox_id[:12], session_id)

    async def cleanup_expired(self) -> int:
        """Remove sandboxes that are idle or have exceeded max lifetime."""
        now = datetime.now(timezone.utc)
        idle_cutoff = now - timedelta(seconds=self._config.idle_timeout_seconds)
        lifetime_cutoff = now - timedelta(seconds=self._config.max_lifetime_seconds)
        expired = [
            sid for sid, info in self._sandboxes.items()
            if info.last_activity < idle_cutoff or info.created_at < lifetime_cutoff
        ]
        for sid in expired:
            logger.info("Sandbox for session %s expired, removing", sid)
            await self.stop(sid)
        return len(expired)

    async def shutdown_all(self) -> None:
        """Kill all tracked sandboxes. Called on backend shutdown."""
        session_ids = list(self._sandboxes.keys())
        for sid in session_ids:
            await self.stop(sid)
        logger.info("Shut down %d sandboxes", len(session_ids))

    async def cleanup_orphaned(self) -> int:
        """Find and kill orphaned sandboxes from previous runs."""
        try:
            async with await OSManager.create(
                connection_config=self._connection_config
            ) as mgr:
                result = await mgr.list_sandbox_infos(
                    SandboxFilter(
                        metadata={"app": "duckdb-agent-sidecar"},
                        states=["RUNNING"],
                    )
                )
                tracked_ids = {info.sandbox_id for info in self._sandboxes.values()}
                orphans = 0
                for sb_info in result.sandbox_infos:
                    if sb_info.id not in tracked_ids:
                        try:
                            await mgr.kill_sandbox(sb_info.id)
                            logger.info("Cleaned up orphaned sandbox %s", sb_info.id[:12])
                            orphans += 1
                        except Exception as e:
                            logger.warning("Failed to kill orphaned sandbox %s: %s", sb_info.id[:12], e)
                return orphans
        except Exception as e:
            logger.warning("Failed to list orphaned sandboxes: %s", e)
            return 0


# --- Module-level singleton ---

try:
    from app.config import (
        CONTAINER_IMAGE,
        CONTAINER_MEMORY_LIMIT,
        CONTAINER_CPU_LIMIT,
        CONTAINER_MAX_LIFETIME_SECONDS,
        CONTAINER_IDLE_TIMEOUT_SECONDS,
        OPENSANDBOX_DOMAIN,
        OPENSANDBOX_API_KEY,
    )

    sandbox_manager = SandboxManager(
        SandboxConfig(
            image=CONTAINER_IMAGE,
            memory_limit=CONTAINER_MEMORY_LIMIT,
            cpu_limit=CONTAINER_CPU_LIMIT,
            max_lifetime_seconds=CONTAINER_MAX_LIFETIME_SECONDS,
            idle_timeout_seconds=CONTAINER_IDLE_TIMEOUT_SECONDS,
            opensandbox_domain=OPENSANDBOX_DOMAIN,
            opensandbox_api_key=OPENSANDBOX_API_KEY,
        )
    )
except Exception as e:
    logger.error("Failed to create sandbox manager: %s", e)
    sandbox_manager = None  # type: ignore[assignment]
```

**Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_sandbox_manager.py -v`
Expected: all tests PASS

**Step 5: Commit**

```bash
git add backend/app/sandbox_manager.py backend/tests/test_sandbox_manager.py
git commit -m "feat: add SandboxManager using OpenSandbox SDK"
```

---

### Task 4: Wire SandboxManager into main.py (replace ContainerManager)

**Files:**
- Modify: `backend/app/main.py:12,23-37,40-51`
- Modify: `backend/app/agent.py:258-260,275-283,313,325,437`

**Step 1: Update main.py imports and lifecycle**

In `backend/app/main.py`:

Replace line 12:
```python
# OLD:
from app.container_manager import container_manager
# NEW:
from app.sandbox_manager import sandbox_manager
```

Update `_cleanup_loop()` (lines 23-37) — change `container_manager` to `sandbox_manager` and make the cleanup call async:

```python
async def _cleanup_loop():
    while True:
        await asyncio.sleep(60)
        try:
            removed = session_manager.cleanup_stale(ttl_seconds=300)
            for sid in removed:
                memory_store.delete_conversations_by_session(sid)
            if removed:
                logger.info("Background cleanup: removed %d stale sessions", len(removed))
            if sandbox_manager is not None:
                sandbox_removed = await sandbox_manager.cleanup_expired()
                if sandbox_removed:
                    logger.info("Background cleanup: removed %d expired sandboxes", sandbox_removed)
        except Exception:
            logger.exception("Error in background cleanup loop")
```

Update `lifespan()` (lines 40-51) — use sandbox_manager with async calls:

```python
@asynccontextmanager
async def lifespan(app):
    if sandbox_manager is not None:
        orphans = await sandbox_manager.cleanup_orphaned()
        if orphans:
            logger.info("Startup: cleaned up %d orphaned sandboxes", orphans)
    task = asyncio.create_task(_cleanup_loop())
    yield
    task.cancel()
    if sandbox_manager is not None:
        await sandbox_manager.shutdown_all()
```

**Step 2: Update agent.py**

In `backend/app/agent.py`:

Replace the container_manager import (line 258):
```python
# OLD:
from app.container_manager import container_manager
# NEW:
from app.sandbox_manager import sandbox_manager
```

Replace the null check (lines 259-260):
```python
# OLD:
if container_manager is None:
    raise RuntimeError("Docker is not available. Container mode requires Docker.")
# NEW:
if sandbox_manager is None:
    raise RuntimeError("OpenSandbox is not available. Container mode requires OpenSandbox.")
```

Replace container creation (line 313):
```python
# OLD:
create_future = loop.run_in_executor(None, container_manager.create, stable_session, env)
# NEW:
info = await sandbox_manager.create(stable_session, env)
```

Note: `sandbox_manager.create` is already async, so no need for `run_in_executor`. Adjust the surrounding code that awaits the future to use the direct return value instead.

Replace touch calls (lines 325, 437):
```python
# OLD:
container_manager.touch(stable_session)
# NEW:
sandbox_manager.touch(stable_session)
```

**Step 3: Run existing tests**

Run: `cd backend && python -m pytest tests/ -v`
Expected: existing tests that mock container_manager may need updating. Update test imports.

**Step 4: Commit**

```bash
git add backend/app/main.py backend/app/agent.py
git commit -m "feat: wire SandboxManager into backend, replacing ContainerManager"
```

---

### Task 5: Create OpenSandbox server configuration

**Files:**
- Create: `sandbox/config.docker.toml`
- Create: `sandbox/config.kubernetes.toml`

**Step 1: Create Docker mode config**

Create `sandbox/config.docker.toml`:

```toml
[server]
host = "0.0.0.0"
port = 8080
log_level = "INFO"

[runtime]
type = "docker"
execd_image = "opensandbox/execd:v1.0.6"

[docker]
network_mode = "bridge"
drop_capabilities = ["ALL"]
no_new_privileges = true
pids_limit = 256
```

**Step 2: Create Kubernetes mode config**

Create `sandbox/config.kubernetes.toml`:

```toml
[server]
host = "0.0.0.0"
port = 8080
log_level = "INFO"

[runtime]
type = "kubernetes"
execd_image = "opensandbox/execd:v1.0.6"

[kubernetes]
namespace = "default"
workload_provider = "agent-sandbox"

[agent_sandbox]
shutdown_policy = "Delete"
```

**Step 3: Commit**

```bash
git add sandbox/
git commit -m "feat: add OpenSandbox server config for Docker and K8s"
```

---

### Task 6: Update docker-compose.yml

**Files:**
- Modify: `docker-compose.yml`

**Step 1: Add OpenSandbox server service and update app service**

Update `docker-compose.yml`:

```yaml
services:
  bifrost:
    # ... unchanged ...

  opensandbox:
    image: opensandbox/server:latest
    container_name: opensandbox
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./sandbox/config.docker.toml:/root/.sandbox.toml
    networks:
      - agent-sandbox
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 10s
      timeout: 5s
      retries: 3
    restart: unless-stopped

  app:
    build:
      context: .
      dockerfile: backend/Dockerfile
      args:
        APP_UID: ${APP_UID:-1000}
    image: duckdb-data-agent:latest
    container_name: duckdb-data-agent
    ports:
      - "${APP_PORT:-10000}:10000"
    env_file:
      - backend/.env
    environment:
      CONTAINER_IMAGE: duckdb-agent-sidecar:latest
      OPENSANDBOX_DOMAIN: opensandbox:8080
      BIFROST_BASE_URL: http://bifrost:8080
      BACKEND_BASE_URL: http://duckdb-data-agent:10000
      SKILLS_DIR: /app/skills
      SKILLS_HOST_PATH: ${SKILLS_HOST_PATH:-${PWD}/skills}
      PLUGINS_HOST_PATH: ${PLUGINS_HOST_PATH:-${PWD}/plugins}
    volumes:
      - ./skills:/app/skills
      - ./plugins:/app/plugins:ro
      - ./data:/app/data
    networks:
      - agent-sandbox
    depends_on:
      bifrost:
        condition: service_healthy
      opensandbox:
        condition: service_healthy
    restart: unless-stopped

  sidecar:
    build:
      context: ./sidecar
      dockerfile: Dockerfile
    image: duckdb-agent-sidecar:latest
    profiles:
      - sidecar

networks:
  agent-sandbox:
    name: agent-sandbox
    external: true
```

Key changes:
- Added `opensandbox` service with Docker socket mount
- Removed Docker socket mount from `app` service (OpenSandbox manages containers now)
- Removed `CONTAINER_NETWORK` env var from `app` (OpenSandbox manages networking)
- Added `OPENSANDBOX_DOMAIN: opensandbox:8080` to `app`
- Removed `group_add` / `DOCKER_GID` from `app` (no longer needs Docker access)
- Added `opensandbox` to `app.depends_on`

**Step 2: Test locally**

Run: `docker compose --profile sidecar build && docker compose up`
Expected: all services start, OpenSandbox server healthy, app connects to OpenSandbox

**Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: add OpenSandbox server to docker-compose, remove Docker socket from app"
```

---

### Task 7: Create Helm chart for Kubernetes deployment

**Files:**
- Create: `deploy/helm/duckdb-data-agent/Chart.yaml`
- Create: `deploy/helm/duckdb-data-agent/values.yaml`
- Create: `deploy/helm/duckdb-data-agent/templates/backend-deployment.yaml`
- Create: `deploy/helm/duckdb-data-agent/templates/backend-service.yaml`
- Create: `deploy/helm/duckdb-data-agent/templates/bifrost-deployment.yaml`
- Create: `deploy/helm/duckdb-data-agent/templates/bifrost-service.yaml`
- Create: `deploy/helm/duckdb-data-agent/templates/opensandbox-deployment.yaml`
- Create: `deploy/helm/duckdb-data-agent/templates/opensandbox-service.yaml`
- Create: `deploy/helm/duckdb-data-agent/templates/configmap.yaml`
- Create: `deploy/helm/duckdb-data-agent/templates/secret.yaml`
- Create: `deploy/helm/duckdb-data-agent/templates/ingress.yaml`

**Step 1: Create Chart.yaml**

```yaml
apiVersion: v2
name: duckdb-data-agent
description: DuckDB Data Agent with OpenSandbox-managed sidecar containers
type: application
version: 0.1.0
appVersion: "1.0.0"
```

**Step 2: Create values.yaml**

```yaml
# Backend
backend:
  image:
    repository: duckdb-data-agent
    tag: latest
    pullPolicy: IfNotPresent
  port: 10000
  replicas: 1
  resources:
    requests:
      cpu: 250m
      memory: 256Mi
    limits:
      cpu: "1"
      memory: 512Mi
  env:
    SANDBOX_RUNTIME: kubernetes
    CONTAINER_IMAGE: duckdb-agent-sidecar:latest

# Bifrost LLM gateway
bifrost:
  image:
    repository: maximhq/bifrost
    tag: latest
    pullPolicy: IfNotPresent
  port: 8080
  replicas: 1
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 256Mi

# OpenSandbox server
opensandbox:
  image:
    repository: opensandbox/server
    tag: latest
    pullPolicy: IfNotPresent
  port: 8080
  replicas: 1
  runtime: kubernetes
  k8sNamespace: default
  workloadProvider: agent-sandbox
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 256Mi

# Sidecar (agent SDK container)
sidecar:
  image:
    repository: duckdb-agent-sidecar
    tag: latest

# Secrets
secrets:
  anthropicApiKey: ""

# Ingress
ingress:
  enabled: false
  className: nginx
  host: duckdb-agent.local
  tls: []

# Persistence
persistence:
  enabled: true
  storageClass: ""
  size: 1Gi
```

**Step 3: Create template files**

Create each Kubernetes manifest template referencing the values. These are standard Helm templates for Deployment, Service, ConfigMap, Secret, and Ingress resources.

Key architectural notes for the templates:
- `opensandbox-deployment.yaml`: Uses in-cluster K8s auth (serviceAccount), mounts the config.kubernetes.toml via ConfigMap
- `backend-deployment.yaml`: Sets `OPENSANDBOX_DOMAIN` to `{{ .Release.Name }}-opensandbox:8080`, `SANDBOX_RUNTIME=kubernetes`
- `configmap.yaml`: Includes OpenSandbox config.toml, Bifrost config.json
- `secret.yaml`: Stores `ANTHROPIC_API_KEY`

**Step 4: Validate chart**

Run: `helm lint deploy/helm/duckdb-data-agent/`
Expected: passes linting

**Step 5: Commit**

```bash
git add deploy/helm/
git commit -m "feat: add Helm chart for Kubernetes deployment"
```

---

### Task 8: Create Kustomize manifests

**Files:**
- Create: `deploy/kustomize/base/kustomization.yaml`
- Create: `deploy/kustomize/base/backend-deployment.yaml`
- Create: `deploy/kustomize/base/backend-service.yaml`
- Create: `deploy/kustomize/base/bifrost-deployment.yaml`
- Create: `deploy/kustomize/base/bifrost-service.yaml`
- Create: `deploy/kustomize/base/opensandbox-deployment.yaml`
- Create: `deploy/kustomize/base/opensandbox-service.yaml`
- Create: `deploy/kustomize/overlays/docker/kustomization.yaml`
- Create: `deploy/kustomize/overlays/docker/patches/`
- Create: `deploy/kustomize/overlays/kubernetes/kustomization.yaml`
- Create: `deploy/kustomize/overlays/kubernetes/patches/`

**Step 1: Create base manifests**

`deploy/kustomize/base/kustomization.yaml`:
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - backend-deployment.yaml
  - backend-service.yaml
  - bifrost-deployment.yaml
  - bifrost-service.yaml
  - opensandbox-deployment.yaml
  - opensandbox-service.yaml
```

Create each base manifest as plain K8s YAML (no Helm templating).

**Step 2: Create overlays**

Docker overlay: patches OpenSandbox deployment to mount Docker socket, sets runtime to "docker".
Kubernetes overlay: patches OpenSandbox to use in-cluster auth, sets runtime to "kubernetes", adds agent-sandbox CRDs.

**Step 3: Validate**

Run: `kubectl kustomize deploy/kustomize/overlays/kubernetes/`
Expected: renders valid YAML

**Step 4: Commit**

```bash
git add deploy/kustomize/
git commit -m "feat: add Kustomize base and overlays for Docker and K8s"
```

---

### Task 9: Remove old ContainerManager

**Files:**
- Delete: `backend/app/container_manager.py`
- Delete: `backend/tests/test_container_manager.py`
- Modify: any remaining references

**Step 1: Search for remaining references**

Run: `grep -r "container_manager" backend/ --include="*.py" -l`
Expected: no files (all references should have been updated in Task 4)

**Step 2: Remove files**

```bash
rm backend/app/container_manager.py
rm backend/tests/test_container_manager.py
```

**Step 3: Remove unused config vars**

In `backend/app/config.py`, remove `CONTAINER_RUNTIME` and `CONTAINER_NETWORK` (no longer needed — OpenSandbox manages these). Keep `CONTAINER_IMAGE`, `CONTAINER_MEMORY_LIMIT`, `CONTAINER_CPU_LIMIT`, `CONTAINER_MAX_LIFETIME_SECONDS`, `CONTAINER_IDLE_TIMEOUT_SECONDS` as they're still used by `sandbox_manager.py`.

**Step 4: Remove `docker` pip dependency**

In `backend/pyproject.toml`, remove `docker` from dependencies (no longer directly used).

**Step 5: Run all tests**

Run: `cd backend && python -m pytest tests/ -v`
Expected: all tests pass

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove ContainerManager and direct Docker SDK dependency"
```

---

### Task 10: Update documentation

**Files:**
- Modify: `docker-compose.yml` (already done)
- Create: `deploy/README.md`

**Step 1: Create deployment README**

Create `deploy/README.md` with sections:
- Prerequisites (Docker or K8s cluster)
- Docker deployment (docker-compose up)
- Kubernetes deployment with Helm
- Kubernetes deployment with Kustomize
- Configuration reference (env vars)
- Troubleshooting

**Step 2: Commit**

```bash
git add deploy/README.md
git commit -m "docs: add deployment guide for Docker and Kubernetes"
```

---

### Task 11: End-to-end verification

**Step 1: Docker mode — full stack test**

```bash
docker compose --profile sidecar build
docker compose up -d
# Wait for all services healthy
curl -s http://localhost:10000/api/config | jq .
# Send a test chat message via API
```

**Step 2: Run E2E tests**

Run: `cd e2e && npx playwright test`
Expected: all existing E2E tests pass

**Step 3: Verify sandbox lifecycle**

- Send a message, verify sandbox created (check OpenSandbox logs)
- Wait for idle timeout, verify sandbox cleaned up
- Restart backend, verify orphan cleanup on startup

**Step 4: Final commit if any fixes needed**
