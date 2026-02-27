# Idle-Based Container Lifecycle

## Problem

`CONTAINER_MAX_LIFETIME_SECONDS` kills containers based purely on wall-clock age since creation. Active user sessions get terminated mid-conversation when the timer expires.

## Design

Add idle-based tracking so containers are reaped when genuinely inactive, with max lifetime retained as a safety backstop.

### Two-tier expiry

A container is removed if **either** condition is true:
- `now - last_activity > idle_timeout` (user stopped interacting)
- `now - created_at > max_lifetime` (absolute cap, safety net)

### Changes

**`ContainerInfo`** — add `last_activity: datetime` field, initialized to `created_at`.

**`ContainerManager`**:
- Add `touch(session_id)` method: updates `last_activity` to `now`.
- Update `cleanup_expired()`: check both idle timeout and max lifetime.

**`ContainerConfig`** — add `idle_timeout_seconds: int` (default 300).

**`agent.py`** — call `container_manager.touch(stable_session)` after `container_manager.create()` returns. `create()` returns early for existing containers, so `touch()` resets idle on every request.

**`config.py`** — add `CONTAINER_IDLE_TIMEOUT_SECONDS` env var.

**`.env.example`** — add `CONTAINER_IDLE_TIMEOUT_SECONDS=300`, update `CONTAINER_MAX_LIFETIME_SECONDS` default to `3600`.

### Defaults
- `CONTAINER_IDLE_TIMEOUT_SECONDS=300` (5 min idle)
- `CONTAINER_MAX_LIFETIME_SECONDS=3600` (1 hour absolute cap)

### Tests
- Container idle longer than timeout → removed
- Container active within timeout → kept
- Container within idle timeout but past max lifetime → removed
