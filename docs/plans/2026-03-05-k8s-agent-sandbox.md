# K8s Agent-Sandbox Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace OpenSandbox with a Strategy Pattern: restore original Docker backend, add kubernetes-sigs/agent-sandbox as K8s backend, behind a common ABC.

**Architecture:** A `SandboxBackend` ABC defines the interface. `DockerBackend` wraps existing `container_manager.py` logic (sync Docker SDK in executor). `K8sBackend` uses `k8s-agent-sandbox` Python SDK (natively async). A factory reads `SANDBOX_RUNTIME` env var to pick the backend.

**Tech Stack:** Python 3.12, FastAPI, Docker SDK, k8s-agent-sandbox (optional), pytest

**Design doc:** `docs/plans/2026-03-05-k8s-agent-sandbox-design.md`

---

### Task 1: Create SandboxBackend ABC and SandboxInfo

**Files:**
- Create: `backend/app/sandbox/__init__.py`
- Create: `backend/app/sandbox/base.py`
- Test: `backend/tests/test_sandbox_base.py`

**Step 1: Write the failing test**

```python
# backend/tests/test_sandbox_base.py
from datetime import datetime, timezone

import pytest

from app.sandbox.base import SandboxBackend, SandboxInfo


def test_sandbox_info_url_stored():
    info = SandboxInfo(
        sandbox_id="abc123",
        session_id="session-1",
        url="http://172.18.0.2:3000",
    )
    assert info.url == "http://172.18.0.2:3000"
    assert info.sandbox_id == "abc123"
    assert info.session_id == "session-1"


def test_sandbox_info_last_activity_defaults_to_created_at():
    info = SandboxInfo(
        sandbox_id="abc123",
        session_id="session-1",
        url="http://172.18.0.2:3000",
    )
    assert info.last_activity == info.created_at


def test_sandbox_backend_cannot_be_instantiated():
    with pytest.raises(TypeError):
        SandboxBackend()
```

**Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_sandbox_base.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.sandbox'`

**Step 3: Write minimal implementation**

```python
# backend/app/sandbox/__init__.py
# Sandbox backend package

# backend/app/sandbox/base.py
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone


@dataclass
class SandboxInfo:
    sandbox_id: str
    session_id: str
    url: str
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    last_activity: datetime = field(default=None)

    def __post_init__(self):
        if self.last_activity is None:
            self.last_activity = self.created_at


class SandboxBackend(ABC):
    @abstractmethod
    async def create(self, session_id: str, env: dict[str, str]) -> SandboxInfo:
        ...

    @abstractmethod
    def get(self, session_id: str) -> SandboxInfo | None:
        ...

    @abstractmethod
    def touch(self, session_id: str) -> None:
        ...

    @abstractmethod
    async def stop(self, session_id: str) -> None:
        ...

    @abstractmethod
    async def cleanup_expired(self) -> int:
        ...

    @abstractmethod
    async def shutdown_all(self) -> None:
        ...

    @abstractmethod
    async def cleanup_orphaned(self) -> int:
        ...
```

**Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_sandbox_base.py -v`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add backend/app/sandbox/__init__.py backend/app/sandbox/base.py backend/tests/test_sandbox_base.py
git commit -m "feat: add SandboxBackend ABC and SandboxInfo dataclass"
```

---

### Task 2: Create DockerBackend

**Files:**
- Create: `backend/app/sandbox/docker_backend.py`
- Test: `backend/tests/test_docker_backend.py`

**Step 1: Write the failing test**

```python
# backend/tests/test_docker_backend.py
import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest

from app.sandbox.docker_backend import DockerBackend, DockerConfig


@pytest.fixture
def config():
    return DockerConfig(
        image="duckdb-agent-sidecar:latest",
        runtime="runsc",
        memory_limit="256m",
        cpu_limit=0.5,
        max_lifetime_seconds=600,
        idle_timeout_seconds=300,
        network="agent-sandbox",
    )


@pytest.fixture
def mock_docker_client():
    client = MagicMock()
    client.containers = MagicMock()
    client.networks = MagicMock()
    return client


@pytest.fixture
def backend(config, mock_docker_client):
    with patch("app.sandbox.docker_backend.docker") as mock_docker:
        mock_docker.from_env.return_value = mock_docker_client
        b = DockerBackend(config)
        b._client = mock_docker_client
        return b


def _make_mock_container(container_id="abc123", ip="172.18.0.2", network="agent-sandbox"):
    mock = MagicMock()
    mock.id = container_id
    mock.attrs = {
        "NetworkSettings": {
            "Networks": {network: {"IPAddress": ip}},
            "Ports": {},
        }
    }
    return mock


def test_docker_config_has_defaults():
    cfg = DockerConfig()
    assert cfg.image == "duckdb-agent-sidecar:latest"
    assert cfg.runtime == "runsc"
    assert cfg.memory_limit == "256m"
    assert cfg.network == "agent-sandbox"


def test_create_returns_sandbox_info(backend, mock_docker_client):
    mock_docker_client.containers.run.return_value = _make_mock_container()
    info = asyncio.get_event_loop().run_until_complete(
        backend.create("session-1", {"ANTHROPIC_API_KEY": "key"})
    )
    assert info.session_id == "session-1"
    assert info.sandbox_id == "abc123"
    assert "172.18.0.2" in info.url


def test_create_passes_security_flags(backend, mock_docker_client):
    mock_docker_client.containers.run.return_value = _make_mock_container()
    asyncio.get_event_loop().run_until_complete(
        backend.create("session-1", {"ANTHROPIC_API_KEY": "key"})
    )
    call_kwargs = mock_docker_client.containers.run.call_args[1]
    assert call_kwargs["runtime"] == "runsc"
    assert call_kwargs["read_only"] is True
    assert call_kwargs["cap_drop"] == ["ALL"]
    assert call_kwargs["security_opt"] == ["no-new-privileges"]


def test_get_returns_info(backend, mock_docker_client):
    mock_docker_client.containers.run.return_value = _make_mock_container()
    asyncio.get_event_loop().run_until_complete(
        backend.create("session-1", {})
    )
    assert backend.get("session-1") is not None
    assert backend.get("nonexistent") is None


def test_touch_updates_last_activity(backend, mock_docker_client):
    mock_docker_client.containers.run.return_value = _make_mock_container()
    asyncio.get_event_loop().run_until_complete(
        backend.create("session-1", {})
    )
    old = backend.get("session-1").last_activity
    import time; time.sleep(0.01)
    backend.touch("session-1")
    assert backend.get("session-1").last_activity > old


def test_touch_nonexistent_is_safe(backend):
    backend.touch("ghost")  # no error


def test_stop_removes_container(backend, mock_docker_client):
    mock_container = _make_mock_container()
    mock_docker_client.containers.run.return_value = mock_container
    asyncio.get_event_loop().run_until_complete(backend.create("session-1", {}))
    asyncio.get_event_loop().run_until_complete(backend.stop("session-1"))
    mock_container.stop.assert_called_once()
    mock_container.remove.assert_called_once_with(force=True)
    assert backend.get("session-1") is None


def test_stop_nonexistent_is_safe(backend):
    asyncio.get_event_loop().run_until_complete(backend.stop("ghost"))


def test_cleanup_expired_removes_old(backend, mock_docker_client):
    mock_docker_client.containers.run.return_value = _make_mock_container()
    asyncio.get_event_loop().run_until_complete(backend.create("old", {}))
    backend._sandboxes["old"].created_at = datetime.now(timezone.utc) - timedelta(seconds=700)
    removed = asyncio.get_event_loop().run_until_complete(backend.cleanup_expired())
    assert removed == 1


def test_cleanup_expired_keeps_recent(backend, mock_docker_client):
    mock_docker_client.containers.run.return_value = _make_mock_container()
    asyncio.get_event_loop().run_until_complete(backend.create("new", {}))
    removed = asyncio.get_event_loop().run_until_complete(backend.cleanup_expired())
    assert removed == 0


def test_shutdown_all_stops_all(backend, mock_docker_client):
    c1 = _make_mock_container("c1", "172.18.0.2")
    c2 = _make_mock_container("c2", "172.18.0.3")
    mock_docker_client.containers.run.side_effect = [c1, c2]
    mock_docker_client.containers.list.return_value = []
    asyncio.get_event_loop().run_until_complete(backend.create("s1", {}))
    asyncio.get_event_loop().run_until_complete(backend.create("s2", {}))
    asyncio.get_event_loop().run_until_complete(backend.shutdown_all())
    c1.stop.assert_called_once()
    c2.stop.assert_called_once()


def test_cleanup_orphaned_finds_unlisted(backend, mock_docker_client):
    orphan = MagicMock()
    orphan.id = "orphan1"
    mock_docker_client.containers.list.return_value = [orphan]
    count = asyncio.get_event_loop().run_until_complete(backend.cleanup_orphaned())
    assert count == 1
    orphan.stop.assert_called_once_with(timeout=5)
    orphan.remove.assert_called_once_with(force=True)
```

**Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_docker_backend.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.sandbox.docker_backend'`

**Step 3: Write minimal implementation**

Move the logic from `backend/app/container_manager.py` into `backend/app/sandbox/docker_backend.py`:
- Rename `ContainerConfig` → `DockerConfig`, `ContainerManager` → `DockerBackend`
- `DockerBackend` extends `SandboxBackend`
- Internal tracking dict renamed `_sandboxes` (stores `SandboxInfo`)
- `create()` is async — runs sync Docker SDK call in `run_in_executor`
- `stop()`, `cleanup_expired()`, `shutdown_all()` are async (wrapping sync calls)
- `cleanup_orphaned()` wraps existing `_cleanup_by_label()`
- All Docker-specific logic (gVisor DNS, host gateway, volumes, extra_hosts) preserved exactly

The `ContainerInfo` dataclass is no longer needed externally — the Docker-specific fields (container_id, ip_address, host_port, _container) are stored in an internal `_DockerContainerState` that maps alongside `SandboxInfo`.

Key internal mapping:
```python
self._sandboxes: dict[str, SandboxInfo] = {}        # session_id -> SandboxInfo
self._docker_state: dict[str, _DockerContainerState] = {}  # session_id -> Docker-specific state
```

Where `_DockerContainerState` holds the Docker container object reference and any Docker-specific fields needed for stop/remove.

**Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_docker_backend.py -v`
Expected: PASS (all tests)

**Step 5: Commit**

```bash
git add backend/app/sandbox/docker_backend.py backend/tests/test_docker_backend.py
git commit -m "feat: add DockerBackend implementing SandboxBackend ABC"
```

---

### Task 3: Create K8sBackend

**Files:**
- Create: `backend/app/sandbox/k8s_backend.py`
- Test: `backend/tests/test_k8s_backend.py`

**Step 1: Write the failing test**

```python
# backend/tests/test_k8s_backend.py
import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.sandbox.k8s_backend import K8sBackend, K8sConfig


@pytest.fixture
def config():
    return K8sConfig(
        template_name="duckdb-agent-sidecar",
        namespace="default",
        gateway_name="",
        server_port=3000,
        max_lifetime_seconds=600,
        idle_timeout_seconds=300,
    )


def test_k8s_config_has_defaults():
    cfg = K8sConfig()
    assert cfg.template_name == "duckdb-agent-sidecar"
    assert cfg.namespace == "default"
    assert cfg.server_port == 3000


def test_create_returns_sandbox_info(config):
    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.sandbox_name = "sandbox-abc123"

    with patch("app.sandbox.k8s_backend.SandboxClient", return_value=mock_client):
        with patch("app.sandbox.k8s_backend._resolve_endpoint", new_callable=AsyncMock, return_value="http://10.0.0.1:3000"):
            backend = K8sBackend(config)
            info = asyncio.get_event_loop().run_until_complete(
                backend.create("session-1", {"ANTHROPIC_API_KEY": "key"})
            )
    assert info.session_id == "session-1"
    assert info.url == "http://10.0.0.1:3000"


def test_get_returns_info(config):
    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.sandbox_name = "sandbox-abc123"

    with patch("app.sandbox.k8s_backend.SandboxClient", return_value=mock_client):
        with patch("app.sandbox.k8s_backend._resolve_endpoint", new_callable=AsyncMock, return_value="http://10.0.0.1:3000"):
            backend = K8sBackend(config)
            asyncio.get_event_loop().run_until_complete(
                backend.create("session-1", {})
            )
    assert backend.get("session-1") is not None
    assert backend.get("nonexistent") is None


def test_touch_updates_last_activity(config):
    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.sandbox_name = "sandbox-abc123"

    with patch("app.sandbox.k8s_backend.SandboxClient", return_value=mock_client):
        with patch("app.sandbox.k8s_backend._resolve_endpoint", new_callable=AsyncMock, return_value="http://10.0.0.1:3000"):
            backend = K8sBackend(config)
            asyncio.get_event_loop().run_until_complete(
                backend.create("session-1", {})
            )
    old = backend.get("session-1").last_activity
    import time; time.sleep(0.01)
    backend.touch("session-1")
    assert backend.get("session-1").last_activity > old


def test_stop_removes_sandbox(config):
    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.sandbox_name = "sandbox-abc123"

    with patch("app.sandbox.k8s_backend.SandboxClient", return_value=mock_client):
        with patch("app.sandbox.k8s_backend._resolve_endpoint", new_callable=AsyncMock, return_value="http://10.0.0.1:3000"):
            backend = K8sBackend(config)
            asyncio.get_event_loop().run_until_complete(
                backend.create("session-1", {})
            )
            asyncio.get_event_loop().run_until_complete(
                backend.stop("session-1")
            )
    mock_client.__aexit__.assert_called()
    assert backend.get("session-1") is None


def test_stop_nonexistent_is_safe(config):
    backend = K8sBackend(config)
    asyncio.get_event_loop().run_until_complete(backend.stop("ghost"))


def test_cleanup_expired_removes_old(config):
    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.sandbox_name = "sandbox-abc123"

    with patch("app.sandbox.k8s_backend.SandboxClient", return_value=mock_client):
        with patch("app.sandbox.k8s_backend._resolve_endpoint", new_callable=AsyncMock, return_value="http://10.0.0.1:3000"):
            backend = K8sBackend(config)
            asyncio.get_event_loop().run_until_complete(
                backend.create("old", {})
            )
    backend._sandboxes["old"].created_at = datetime.now(timezone.utc) - timedelta(seconds=700)
    removed = asyncio.get_event_loop().run_until_complete(backend.cleanup_expired())
    assert removed == 1
```

**Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_k8s_backend.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.sandbox.k8s_backend'`

**Step 3: Write minimal implementation**

```python
# backend/app/sandbox/k8s_backend.py
import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from app.sandbox.base import SandboxBackend, SandboxInfo

try:
    from k8s_agent_sandbox import SandboxClient
except ImportError:
    SandboxClient = None  # type: ignore[assignment,misc]

logger = logging.getLogger(__name__)


async def _resolve_endpoint(client, port: int) -> str:
    """Resolve the sandbox endpoint URL after creation."""
    # The SandboxClient exposes the sandbox's routable address
    # after __aenter__ completes. Build the URL from it.
    # Exact attribute depends on SDK version — may need adjustment.
    return f"http://{client.host}:{port}"


@dataclass
class K8sConfig:
    template_name: str = "duckdb-agent-sidecar"
    namespace: str = "default"
    gateway_name: str = ""
    server_port: int = 3000
    max_lifetime_seconds: int = 3600
    idle_timeout_seconds: int = 300


class K8sBackend(SandboxBackend):
    def __init__(self, config: K8sConfig | None = None):
        self._config = config or K8sConfig()
        self._sandboxes: dict[str, SandboxInfo] = {}
        self._clients: dict[str, object] = {}  # session_id -> SandboxClient (for cleanup)
        self._lock = asyncio.Lock()

    async def create(self, session_id: str, env: dict[str, str]) -> SandboxInfo:
        if SandboxClient is None:
            raise RuntimeError(
                "k8s-agent-sandbox is not installed. "
                "Install it with: pip install k8s-agent-sandbox"
            )
        async with self._lock:
            if session_id in self._sandboxes:
                return self._sandboxes[session_id]

            client = SandboxClient(
                template_name=self._config.template_name,
                namespace=self._config.namespace,
                **({"gateway_name": self._config.gateway_name} if self._config.gateway_name else {}),
                server_port=self._config.server_port,
            )
            await client.__aenter__()

            endpoint = await _resolve_endpoint(client, self._config.server_port)
            info = SandboxInfo(
                sandbox_id=getattr(client, "sandbox_name", session_id),
                session_id=session_id,
                url=endpoint,
            )
            self._sandboxes[session_id] = info
            self._clients[session_id] = client
            return info

    def get(self, session_id: str) -> SandboxInfo | None:
        return self._sandboxes.get(session_id)

    def touch(self, session_id: str) -> None:
        info = self._sandboxes.get(session_id)
        if info is not None:
            info.last_activity = datetime.now(timezone.utc)

    async def stop(self, session_id: str) -> None:
        async with self._lock:
            await self._stop_unlocked(session_id)

    async def _stop_unlocked(self, session_id: str) -> None:
        info = self._sandboxes.pop(session_id, None)
        client = self._clients.pop(session_id, None)
        if client is None:
            return
        try:
            await client.__aexit__(None, None, None)
        except Exception as e:
            logger.warning("Failed to stop K8s sandbox for %s: %s", session_id, e)

    async def cleanup_expired(self) -> int:
        async with self._lock:
            now = datetime.now(timezone.utc)
            idle_cutoff = now - timedelta(seconds=self._config.idle_timeout_seconds)
            lifetime_cutoff = now - timedelta(seconds=self._config.max_lifetime_seconds)
            expired = [
                sid for sid, info in self._sandboxes.items()
                if info.last_activity < idle_cutoff or info.created_at < lifetime_cutoff
            ]
            for sid in expired:
                await self._stop_unlocked(sid)
            return len(expired)

    async def shutdown_all(self) -> None:
        async with self._lock:
            for sid in list(self._sandboxes.keys()):
                await self._stop_unlocked(sid)

    async def cleanup_orphaned(self) -> int:
        # K8s controller handles orphan cleanup via ownerReferences.
        # No manual cleanup needed — the Sandbox CR deletion cascades to pods.
        return 0
```

**Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_k8s_backend.py -v`
Expected: PASS (all tests)

**Step 5: Commit**

```bash
git add backend/app/sandbox/k8s_backend.py backend/tests/test_k8s_backend.py
git commit -m "feat: add K8sBackend implementing SandboxBackend ABC"
```

---

### Task 4: Add config vars and factory function

**Files:**
- Modify: `backend/app/config.py:50-57` (add new vars)
- Modify: `backend/app/sandbox/__init__.py` (add factory)
- Test: `backend/tests/test_sandbox_factory.py`

**Step 1: Write the failing test**

```python
# backend/tests/test_sandbox_factory.py
from unittest.mock import patch

import pytest


def test_factory_returns_docker_backend_by_default():
    with patch("app.sandbox.docker_backend.docker") as mock_docker:
        mock_docker.from_env.return_value = None
        from app.sandbox import get_sandbox_backend
        backend = get_sandbox_backend()
    from app.sandbox.docker_backend import DockerBackend
    assert isinstance(backend, DockerBackend)


def test_factory_returns_k8s_backend():
    with patch.dict("os.environ", {"SANDBOX_RUNTIME": "k8s"}):
        from importlib import reload
        import app.config
        reload(app.config)
        from app.sandbox import get_sandbox_backend
        backend = get_sandbox_backend()
    from app.sandbox.k8s_backend import K8sBackend
    assert isinstance(backend, K8sBackend)


def test_factory_raises_on_unknown_runtime():
    with pytest.raises(ValueError, match="Unknown SANDBOX_RUNTIME"):
        from app.sandbox import get_sandbox_backend
        get_sandbox_backend(runtime="invalid")
```

**Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_sandbox_factory.py -v`
Expected: FAIL — `ImportError: cannot import name 'get_sandbox_backend'`

**Step 3: Write minimal implementation**

Add to `backend/app/config.py` after the existing container vars:

```python
# Sandbox runtime selection
SANDBOX_RUNTIME = os.getenv("SANDBOX_RUNTIME", "docker")  # "docker" | "k8s"

# K8s-specific (only used when SANDBOX_RUNTIME="k8s")
K8S_TEMPLATE_NAME = os.getenv("K8S_TEMPLATE_NAME", "duckdb-agent-sidecar")
K8S_NAMESPACE = os.getenv("K8S_NAMESPACE", "default")
K8S_GATEWAY_NAME = os.getenv("K8S_GATEWAY_NAME", "")
```

Update `backend/app/sandbox/__init__.py`:

```python
from app.sandbox.base import SandboxBackend, SandboxInfo


def get_sandbox_backend(runtime: str | None = None) -> SandboxBackend:
    from app.config import SANDBOX_RUNTIME
    rt = runtime or SANDBOX_RUNTIME

    if rt == "docker":
        from app.sandbox.docker_backend import DockerBackend, DockerConfig
        from app.config import (
            CONTAINER_IMAGE, CONTAINER_RUNTIME, CONTAINER_MEMORY_LIMIT,
            CONTAINER_CPU_LIMIT, CONTAINER_MAX_LIFETIME_SECONDS,
            CONTAINER_IDLE_TIMEOUT_SECONDS, CONTAINER_NETWORK,
        )
        return DockerBackend(DockerConfig(
            image=CONTAINER_IMAGE,
            runtime=CONTAINER_RUNTIME,
            memory_limit=CONTAINER_MEMORY_LIMIT,
            cpu_limit=CONTAINER_CPU_LIMIT,
            max_lifetime_seconds=CONTAINER_MAX_LIFETIME_SECONDS,
            idle_timeout_seconds=CONTAINER_IDLE_TIMEOUT_SECONDS,
            network=CONTAINER_NETWORK,
        ))
    elif rt == "k8s":
        from app.sandbox.k8s_backend import K8sBackend, K8sConfig
        from app.config import (
            K8S_TEMPLATE_NAME, K8S_NAMESPACE, K8S_GATEWAY_NAME,
            CONTAINER_MAX_LIFETIME_SECONDS, CONTAINER_IDLE_TIMEOUT_SECONDS,
        )
        return K8sBackend(K8sConfig(
            template_name=K8S_TEMPLATE_NAME,
            namespace=K8S_NAMESPACE,
            gateway_name=K8S_GATEWAY_NAME,
            max_lifetime_seconds=CONTAINER_MAX_LIFETIME_SECONDS,
            idle_timeout_seconds=CONTAINER_IDLE_TIMEOUT_SECONDS,
        ))
    else:
        raise ValueError(f"Unknown SANDBOX_RUNTIME: {rt!r}. Use 'docker' or 'k8s'.")
```

**Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_sandbox_factory.py -v`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add backend/app/config.py backend/app/sandbox/__init__.py backend/tests/test_sandbox_factory.py
git commit -m "feat: add SANDBOX_RUNTIME config and factory function"
```

---

### Task 5: Wire sandbox backend into main.py

**Files:**
- Modify: `backend/app/main.py`

**Step 1: Update imports and lifespan**

Replace `container_manager` references with `sandbox_backend`:

```python
# main.py changes:
# - from app.container_manager import container_manager
# + from app.sandbox import get_sandbox_backend
#
# Module-level:
# sandbox_backend = get_sandbox_backend()
#
# _cleanup_loop:
#   container_manager.cleanup_expired()
#   becomes: await sandbox_backend.cleanup_expired()
#
# lifespan startup:
#   container_manager._cleanup_by_label()
#   becomes: await sandbox_backend.cleanup_orphaned()
#
# lifespan shutdown:
#   container_manager.shutdown_all()
#   becomes: await sandbox_backend.shutdown_all()
```

Important: The cleanup loop already runs in an `async def`, so `await` works directly. The lifespan is also async.

**Step 2: Run existing tests to verify nothing breaks**

Run: `cd backend && python -m pytest tests/ -v --ignore=tests/test_container_manager.py`
Expected: PASS (the container_manager tests will be updated in Task 7)

**Step 3: Commit**

```bash
git add backend/app/main.py
git commit -m "feat: wire sandbox backend into main.py lifespan and cleanup"
```

---

### Task 6: Wire sandbox backend into agent.py

**Files:**
- Modify: `backend/app/agent.py:258-325,437`

**Step 1: Update container_manager references**

```python
# agent.py changes (inside stream_chat_container):

# Replace:
#   from app.container_manager import container_manager
#   if container_manager is None:
#       raise RuntimeError("Docker is not available...")
# With:
#   from app.sandbox import get_sandbox_backend
#   sandbox_backend = get_sandbox_backend()

# Replace the create block (lines 308-324):
#   loop = asyncio.get_event_loop()
#   create_future = loop.run_in_executor(None, container_manager.create, ...)
#   ... polling loop ...
#   info = await create_future
# With:
#   create_task = asyncio.create_task(sandbox_backend.create(stable_session, env))
#   max_create_wait = 60.0
#   elapsed = 0.0
#   while not create_task.done():
#       await asyncio.sleep(2.0)
#       elapsed += 2.0
#       if elapsed >= max_create_wait:
#           create_task.cancel()
#           raise RuntimeError(...)
#       yield ": keepalive\n\n"
#   info = await create_task

# Replace:
#   container_manager.touch(stable_session)
# With:
#   sandbox_backend.touch(stable_session)
```

The key change: `create()` is now async on both backends, so no more `run_in_executor` at the call site. The keepalive polling pattern stays the same.

**Step 2: Run existing tests**

Run: `cd backend && python -m pytest tests/ -v --ignore=tests/test_container_manager.py`
Expected: PASS

**Step 3: Commit**

```bash
git add backend/app/agent.py
git commit -m "feat: wire sandbox backend into agent.py stream_chat_container"
```

---

### Task 7: Delete container_manager.py and update old tests

**Files:**
- Delete: `backend/app/container_manager.py`
- Delete: `backend/tests/test_container_manager.py`

**Step 1: Verify no remaining references to container_manager**

Run: `grep -r "container_manager" backend/app/ --include="*.py"`
Expected: No results (all references updated in Tasks 5-6)

**Step 2: Delete files**

```bash
git rm backend/app/container_manager.py backend/tests/test_container_manager.py
```

**Step 3: Run all tests**

Run: `cd backend && python -m pytest tests/ -v`
Expected: PASS (all tests)

**Step 4: Commit**

```bash
git commit -m "refactor: remove container_manager.py (replaced by sandbox/ package)"
```

---

### Task 8: Add k8s-agent-sandbox as optional dependency

**Files:**
- Modify: `backend/pyproject.toml`

**Step 1: Add optional dependency**

```toml
[tool.poetry.dependencies]
# ... existing deps ...
k8s-agent-sandbox = {version = "^0.1.1", optional = true}

[tool.poetry.extras]
k8s = ["k8s-agent-sandbox"]
```

**Step 2: Verify install works**

Run: `cd backend && poetry lock --no-update`
Expected: Lock file updated successfully

**Step 3: Commit**

```bash
git add backend/pyproject.toml backend/poetry.lock
git commit -m "feat: add k8s-agent-sandbox as optional dependency"
```

---

### Task 9: Add K8s deployment manifests

**Files:**
- Create: `deploy/k8s/sandbox-template.yaml`
- Create: `deploy/k8s/warm-pool.yaml`
- Create: `deploy/k8s/README.md`

**Step 1: Create SandboxTemplate manifest**

```yaml
# deploy/k8s/sandbox-template.yaml
apiVersion: extensions.agents.x-k8s.io/v1alpha1
kind: SandboxTemplate
metadata:
  name: duckdb-agent-sidecar
spec:
  podTemplate:
    metadata:
      labels:
        app: duckdb-agent-sidecar
    spec:
      runtimeClassName: gvisor
      containers:
      - name: sidecar
        image: duckdb-agent-sidecar:latest
        ports:
        - containerPort: 3000
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 3
          periodSeconds: 10
        resources:
          requests:
            cpu: "250m"
            memory: "256Mi"
          limits:
            cpu: "500m"
            memory: "512Mi"
        securityContext:
          readOnlyRootFilesystem: true
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
```

**Step 2: Create WarmPool manifest**

```yaml
# deploy/k8s/warm-pool.yaml
apiVersion: extensions.agents.x-k8s.io/v1alpha1
kind: SandboxWarmPool
metadata:
  name: duckdb-agent-sidecar-pool
spec:
  replicas: 2
  sandboxTemplateRef:
    name: duckdb-agent-sidecar
```

**Step 3: Create README**

Brief doc covering: prerequisites (agent-sandbox controller), applying manifests, verifying pods, configuring backend env vars.

**Step 4: Commit**

```bash
git add deploy/k8s/
git commit -m "feat: add K8s SandboxTemplate and WarmPool manifests"
```

---

### Task 10: Run full test suite and final verification

**Step 1: Run all tests**

Run: `cd backend && python -m pytest tests/ -v`
Expected: All tests PASS

**Step 2: Verify Docker workflow still works locally**

Run: `make dev` (or equivalent docker-compose up)
Expected: Backend starts, creates Docker sidecar containers as before

**Step 3: Verify no leftover references**

Run: `grep -r "opensandbox\|OpenSandbox\|container_manager" backend/app/ --include="*.py"`
Expected: No results

**Step 4: Final commit if any fixups needed**

```bash
git add -A && git commit -m "fix: address final review issues"
```
