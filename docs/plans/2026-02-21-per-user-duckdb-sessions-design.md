# Per-User DuckDB Sessions Design

**Date:** 2026-02-21
**Status:** Approved

## Overview

Allow each user to operate against their own isolated in-memory DuckDB instance. Users are identified by a frontend-generated UUID (stored in React memory only). When a user closes the tab, their DuckDB instance is destroyed and all uploaded data is gone. Users are warned via the browser's native "Leave site?" confirmation dialog.

## Background

The current architecture uses a single DuckDB singleton shared across all users (`backend/app/database.py`). Any user can see all tables uploaded by any other user. This design replaces that singleton with per-session isolation.

## Goals

- Full DuckDB isolation per browser tab / page load
- Automatic cleanup on tab close (immediate) and on disconnect (TTL-based fallback)
- User confirmation prompt before data is lost
- No persistence across page reloads (ephemeral by design)

## Non-Goals

- Per-user Claude agent session isolation (agent sessions remain as-is)
- Authentication or user accounts
- Data persistence or export before close
- Custom close-dialog messages (not supported by browsers)

## Approach

Frontend generates a `crypto.randomUUID()` on page load, stored in a new `SessionContext` (React memory only, not `localStorage`). Every API request includes this UUID as an `X-Session-ID` header. The backend `SessionManager` creates a new `duckdb.connect(":memory:")` for each unseen session ID and tracks sessions in a dict.

Alternatives considered and rejected:
- **Backend-assigned hash(ip + timestamp)**: Extra round-trip on load; IP-based IDs break behind NAT/proxies in Docker.
- **FastAPI cookie-based middleware**: Cookies persist across tabs and restarts, breaking the ephemeral-data intent.

## Architecture

### Session Lifecycle

1. Browser loads the page → frontend calls `crypto.randomUUID()` → stored in `SessionContext`
2. Every `fetch()` / SSE request attaches `X-Session-ID: <uuid>` header
3. Backend `SessionManager` creates a new `Database(duckdb.connect(":memory:"))` on first request for an unseen ID
4. `SessionManager` tracks `{ session_id → { db: Database, last_seen_at: datetime } }`
5. On cleanup: DuckDB connection is closed, session entry removed from dict

### Components

| File | Change | Purpose |
|------|--------|---------|
| `backend/app/session_manager.py` | **New** | `SessionManager` class: create, retrieve, destroy sessions |
| `backend/app/database.py` | **Refactor** | Remove module-level singleton; `Database` becomes instantiable per-session |
| `backend/app/main.py` | **Modify** | Register new endpoints; start background cleanup task on startup |
| `backend/app/routes/*.py` | **Modify** | Replace global `db` import with `Depends(get_session_db)` |
| `frontend/src/contexts/SessionContext.tsx` | **New** | Generate UUID on mount, expose via context hook |
| `frontend/src/agent/agentService.ts` | **Modify** | Attach `X-Session-ID` to SSE request |
| All other `fetch()` calls in frontend | **Modify** | Attach `X-Session-ID` header |

## Session Cleanup

### Dual-mechanism strategy

| Scenario | Cleanup method | Latency |
|----------|---------------|---------|
| Normal tab close | `beforeunload` beacon → immediate | < 1s |
| Browser crash / network drop | Heartbeat timeout background task | ~5 min |
| User navigates away | `beforeunload` beacon → immediate | < 1s |
| Server restart | All in-memory instances lost by definition | Instant |

### Heartbeat

- Frontend: `setInterval(() => POST /api/heartbeat, 30_000)` — sends `X-Session-ID` header
- Backend: updates `last_seen_at` for the session
- Background task (started on FastAPI startup via `asyncio`): runs every 60s, destroys sessions where `last_seen_at > 5 minutes ago`

### Immediate cleanup on close

- `beforeunload` listener calls `navigator.sendBeacon('/api/session/cleanup', JSON.stringify({ sessionId }))` — chosen over `fetch` because `sendBeacon` is guaranteed to fire even as the tab closes
- Backend `/api/session/cleanup` closes the DuckDB connection and removes the session entry

### Confirmation prompt

- Same `beforeunload` handler sets `event.preventDefault()` + `event.returnValue = ''` to trigger the browser's native "Leave site?" dialog
- Custom messages are not supported by modern browsers; the generic browser prompt is sufficient
- The beacon fires regardless of confirm/cancel. If the user cancels, the next API request re-creates the session automatically (starting fresh with an empty DuckDB)

## API Contract

### New Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `POST /api/heartbeat` | POST | `X-Session-ID` header | Refresh session TTL; returns `200 OK` |
| `POST /api/session/cleanup` | POST | `X-Session-ID` header (beacon body) | Immediately destroy session; returns `200 OK` |

### Modified Existing Endpoints

All existing routes (`/api/tables`, `/api/upload`, `/api/query`, `/api/chat`, etc.) gain a FastAPI dependency:

```python
async def get_session_db(x_session_id: str = Header(...)) -> Database:
    return session_manager.get_or_create(x_session_id)
```

This replaces the current direct import of the global `db` singleton. **No changes to request/response bodies.**

### SessionManager Internal State

```python
@dataclass
class SessionEntry:
    db: Database
    last_seen_at: datetime

class SessionManager:
    sessions: dict[str, SessionEntry]

    def get_or_create(self, session_id: str) -> Database: ...
    def touch(self, session_id: str) -> None: ...
    def destroy(self, session_id: str) -> None: ...
    def cleanup_stale(self, ttl_seconds: int = 300) -> None: ...
```

## Error Handling

- **Missing `X-Session-ID` header**: Return `400 Bad Request`
- **Session not found on `/api/heartbeat`**: Return `404`; frontend should treat this as a signal to reload (session was cleaned up server-side)
- **Session not found on cleanup**: Return `200` (idempotent — already cleaned up)
- **DuckDB close error**: Log and swallow; stale connection will be GC'd

## Testing Considerations

- Unit test `SessionManager`: create, get, destroy, stale cleanup
- Integration test: two concurrent requests with different session IDs see isolated table lists
- Integration test: heartbeat TTL — session is destroyed after timeout without heartbeat
- Frontend test: `beforeunload` fires beacon and shows confirmation dialog
- Frontend test: new UUID generated on each page mount (not persisted)
