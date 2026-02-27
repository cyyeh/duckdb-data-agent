# Idle-Based Container Lifecycle Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add idle-based tracking so active container sessions don't get killed, while keeping max lifetime as a safety backstop.

**Architecture:** Add `last_activity` timestamp to `ContainerInfo`, a `touch()` method on `ContainerManager`, and update `cleanup_expired()` to check both idle timeout and max lifetime. Touch on every request in `agent.py`.

**Tech Stack:** Python, FastAPI, Docker SDK

---

### Task 1: Add idle_timeout_seconds to ContainerConfig and config.py

**Files:**
- Modify: `backend/app/container_manager.py:14-20`
- Modify: `backend/app/config.py:53-59`
- Modify: `backend/.env.example:35-44`

**Step 1: Add `idle_timeout_seconds` to `ContainerConfig` dataclass**

In `backend/app/container_manager.py`, add the field after `max_lifetime_seconds`:

```python
@dataclass
class ContainerConfig:
    image: str = "duckdb-agent-sidecar:latest"
    runtime: str = "runsc"
    memory_limit: str = "256m"
    cpu_limit: float = 0.5
    max_lifetime_seconds: int = 3600
    idle_timeout_seconds: int = 300
    network: str = "agent-sandbox"
```

**Step 2: Add config var to `backend/app/config.py`**

After line 58 (`CONTAINER_MAX_LIFETIME_SECONDS`), add:

```python
CONTAINER_IDLE_TIMEOUT_SECONDS = int(os.getenv("CONTAINER_IDLE_TIMEOUT_SECONDS", "300"))
```

**Step 3: Update the module-level `container_manager` instantiation**

In `backend/app/container_manager.py:287-309`, add the import and pass the new field:

```python
from app.config import (
    CONTAINER_IMAGE,
    CONTAINER_RUNTIME,
    CONTAINER_MEMORY_LIMIT,
    CONTAINER_CPU_LIMIT,
    CONTAINER_MAX_LIFETIME_SECONDS,
    CONTAINER_IDLE_TIMEOUT_SECONDS,
    CONTAINER_NETWORK,
)

container_manager = ContainerManager(
    ContainerConfig(
        image=CONTAINER_IMAGE,
        runtime=CONTAINER_RUNTIME,
        memory_limit=CONTAINER_MEMORY_LIMIT,
        cpu_limit=CONTAINER_CPU_LIMIT,
        max_lifetime_seconds=CONTAINER_MAX_LIFETIME_SECONDS,
        idle_timeout_seconds=CONTAINER_IDLE_TIMEOUT_SECONDS,
        network=CONTAINER_NETWORK,
    )
)
```

**Step 4: Update `.env.example`**

In `backend/.env.example`, update the container settings section:

```
# Container settings (Docker required)
CONTAINER_IMAGE=duckdb-agent-sidecar:latest
CONTAINER_RUNTIME=runc  # use `runsc` for gVisor
CONTAINER_MEMORY_LIMIT=512m
CONTAINER_CPU_LIMIT=0.5
CONTAINER_MAX_LIFETIME_SECONDS=3600
CONTAINER_IDLE_TIMEOUT_SECONDS=300
CONTAINER_NETWORK=agent-sandbox
```

**Step 5: Commit**

```bash
git add backend/app/container_manager.py backend/app/config.py backend/.env.example
git commit -m "feat: add CONTAINER_IDLE_TIMEOUT_SECONDS config"
```

---

### Task 2: Add last_activity field and touch() method

**Files:**
- Modify: `backend/app/container_manager.py:23-30` (ContainerInfo)
- Modify: `backend/app/container_manager.py:194-196` (ContainerManager.get)
- Test: `backend/tests/test_container_manager.py`

**Step 1: Write the failing tests**

Add to `backend/tests/test_container_manager.py`:

```python
def test_container_info_has_last_activity(manager, mock_docker_client):
    mock_container = MagicMock()
    mock_container.id = "abc123"
    mock_container.attrs = {"NetworkSettings": {"Networks": {"agent-sandbox": {"IPAddress": "172.18.0.2"}}}}
    mock_docker_client.containers.run.return_value = mock_container

    info = manager.create("session-1", {})
    assert info.last_activity is not None
    assert info.last_activity == info.created_at


def test_touch_updates_last_activity(manager, mock_docker_client):
    mock_container = MagicMock()
    mock_container.id = "abc123"
    mock_container.attrs = {"NetworkSettings": {"Networks": {"agent-sandbox": {"IPAddress": "172.18.0.2"}}}}
    mock_docker_client.containers.run.return_value = mock_container

    manager.create("session-1", {})
    old_activity = manager._containers["session-1"].last_activity

    # Small sleep to ensure time difference
    import time
    time.sleep(0.01)

    manager.touch("session-1")
    new_activity = manager._containers["session-1"].last_activity
    assert new_activity > old_activity


def test_touch_nonexistent_session_is_safe(manager):
    manager.touch("ghost-session")  # must not raise
```

**Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_container_manager.py::test_container_info_has_last_activity tests/test_container_manager.py::test_touch_updates_last_activity tests/test_container_manager.py::test_touch_nonexistent_session_is_safe -v`
Expected: FAIL

**Step 3: Add `last_activity` field to `ContainerInfo`**

In `backend/app/container_manager.py`, update `ContainerInfo`:

```python
@dataclass
class ContainerInfo:
    container_id: str
    session_id: str
    ip_address: str
    port: int = 3000
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    last_activity: datetime = field(default=None)
    _container: object = field(default=None, repr=False)

    host_port: int | None = None

    def __post_init__(self):
        if self.last_activity is None:
            self.last_activity = self.created_at
```

**Step 4: Add `touch()` method to `ContainerManager`**

After the `get()` method (line ~196), add:

```python
def touch(self, session_id: str) -> None:
    """Update last_activity timestamp for a session's container."""
    info = self._containers.get(session_id)
    if info is not None:
        info.last_activity = datetime.now(timezone.utc)
```

**Step 5: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_container_manager.py::test_container_info_has_last_activity tests/test_container_manager.py::test_touch_updates_last_activity tests/test_container_manager.py::test_touch_nonexistent_session_is_safe -v`
Expected: PASS

**Step 6: Commit**

```bash
git add backend/app/container_manager.py backend/tests/test_container_manager.py
git commit -m "feat: add last_activity field and touch() method to ContainerManager"
```

---

### Task 3: Update cleanup_expired() to check both idle and max lifetime

**Files:**
- Modify: `backend/app/container_manager.py:216-226` (cleanup_expired)
- Test: `backend/tests/test_container_manager.py`

**Step 1: Write the failing tests**

Add to `backend/tests/test_container_manager.py`:

```python
def test_cleanup_expired_removes_idle_containers(manager, mock_docker_client):
    """Container idle longer than idle_timeout is removed."""
    mock_container = MagicMock()
    mock_container.id = "abc123"
    mock_container.attrs = {"NetworkSettings": {"Networks": {"agent-sandbox": {"IPAddress": "172.18.0.2"}}}}
    mock_docker_client.containers.run.return_value = mock_container

    manager.create("idle-session", {})
    # Created recently, but last_activity is old
    manager._containers["idle-session"].last_activity = (
        datetime.now(timezone.utc) - timedelta(seconds=400)
    )

    removed = manager.cleanup_expired()
    assert removed == 1
    assert "idle-session" not in manager._containers


def test_cleanup_expired_keeps_active_containers(manager, mock_docker_client):
    """Container within idle timeout is kept even if created long ago."""
    mock_container = MagicMock()
    mock_container.id = "abc123"
    mock_container.attrs = {"NetworkSettings": {"Networks": {"agent-sandbox": {"IPAddress": "172.18.0.2"}}}}
    mock_docker_client.containers.run.return_value = mock_container

    manager.create("active-session", {})
    # Created long ago, but recently active
    manager._containers["active-session"].created_at = (
        datetime.now(timezone.utc) - timedelta(seconds=500)
    )
    manager._containers["active-session"].last_activity = datetime.now(timezone.utc)

    removed = manager.cleanup_expired()
    assert removed == 0
    assert "active-session" in manager._containers


def test_cleanup_expired_removes_past_max_lifetime_even_if_active(manager, mock_docker_client):
    """Container past max_lifetime is removed even if recently active."""
    mock_container = MagicMock()
    mock_container.id = "abc123"
    mock_container.attrs = {"NetworkSettings": {"Networks": {"agent-sandbox": {"IPAddress": "172.18.0.2"}}}}
    mock_docker_client.containers.run.return_value = mock_container

    manager.create("old-active-session", {})
    # Past max lifetime but recently active
    manager._containers["old-active-session"].created_at = (
        datetime.now(timezone.utc) - timedelta(seconds=700)
    )
    manager._containers["old-active-session"].last_activity = datetime.now(timezone.utc)

    removed = manager.cleanup_expired()
    assert removed == 1
    assert "old-active-session" not in manager._containers
```

**Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_container_manager.py::test_cleanup_expired_removes_idle_containers tests/test_container_manager.py::test_cleanup_expired_keeps_active_containers tests/test_container_manager.py::test_cleanup_expired_removes_past_max_lifetime_even_if_active -v`
Expected: FAIL (idle test should fail because current code only checks created_at; active-but-old test might pass by coincidence with current code)

**Step 3: Update `cleanup_expired()`**

In `backend/app/container_manager.py`, replace the `cleanup_expired` method:

```python
def cleanup_expired(self) -> int:
    """Remove containers that are idle or have exceeded max lifetime."""
    now = datetime.now(timezone.utc)
    idle_cutoff = now - timedelta(seconds=self._config.idle_timeout_seconds)
    lifetime_cutoff = now - timedelta(seconds=self._config.max_lifetime_seconds)
    expired = [
        sid for sid, info in self._containers.items()
        if info.last_activity < idle_cutoff or info.created_at < lifetime_cutoff
    ]
    for sid in expired:
        logger.info("Container for session %s expired (idle or max lifetime), removing", sid)
        self.stop(sid)
    return len(expired)
```

**Step 4: Run all container manager tests**

Run: `cd backend && python -m pytest tests/test_container_manager.py -v`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add backend/app/container_manager.py backend/tests/test_container_manager.py
git commit -m "feat: cleanup_expired checks both idle timeout and max lifetime"
```

---

### Task 4: Call touch() in agent.py on each request

**Files:**
- Modify: `backend/app/agent.py:249` (after create_future resolves)

**Step 1: Add touch() call after container creation**

In `backend/app/agent.py`, after line 249 (`info = await create_future`), add:

```python
        info = await create_future
        container_manager.touch(stable_session)
```

**Step 2: Run full test suite to verify nothing is broken**

Run: `cd backend && python -m pytest -v`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add backend/app/agent.py
git commit -m "feat: touch container on each request to reset idle timer"
```

---

### Task 5: Update existing test fixture defaults and config defaults

**Files:**
- Modify: `backend/tests/test_container_manager.py:11-19` (config fixture)
- Modify: `backend/app/container_manager.py:19` (default max_lifetime_seconds)

**Step 1: Update test fixture to include idle_timeout_seconds**

In `backend/tests/test_container_manager.py`, update the `config` fixture:

```python
@pytest.fixture
def config():
    return ContainerConfig(
        image="duckdb-agent-sidecar:latest",
        runtime="runsc",
        memory_limit="256m",
        cpu_limit=0.5,
        max_lifetime_seconds=600,
        idle_timeout_seconds=300,
        network="agent-sandbox",
    )
```

**Step 2: Update the default config test**

In `backend/tests/test_container_manager.py`, update `test_container_config_has_defaults`:

```python
def test_container_config_has_defaults():
    cfg = ContainerConfig()
    assert cfg.image == "duckdb-agent-sidecar:latest"
    assert cfg.runtime == "runsc"
    assert cfg.memory_limit == "256m"
    assert cfg.cpu_limit == 0.5
    assert cfg.max_lifetime_seconds == 3600
    assert cfg.idle_timeout_seconds == 300
    assert cfg.network == "agent-sandbox"
```

**Step 3: Run full test suite**

Run: `cd backend && python -m pytest tests/test_container_manager.py -v`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add backend/tests/test_container_manager.py backend/app/container_manager.py
git commit -m "chore: update test fixtures and defaults for idle timeout"
```

---

### Task 6: Update design doc and .env

**Files:**
- Modify: `backend/.env:21` (update CONTAINER_MAX_LIFETIME_SECONDS, add CONTAINER_IDLE_TIMEOUT_SECONDS)

**Step 1: Update `.env`**

Update `CONTAINER_MAX_LIFETIME_SECONDS=3600` and add `CONTAINER_IDLE_TIMEOUT_SECONDS=300` after it.

**Step 2: Run full test suite one final time**

Run: `cd backend && python -m pytest -v`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add backend/.env docs/plans/2026-02-27-idle-based-container-lifecycle-design.md docs/plans/2026-02-27-idle-based-container-lifecycle.md
git commit -m "docs: add idle-based container lifecycle design and update .env defaults"
```
