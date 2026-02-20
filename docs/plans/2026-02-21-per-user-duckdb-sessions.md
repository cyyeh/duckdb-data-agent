# Per-User DuckDB Sessions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the global DuckDB singleton with per-user isolated in-memory instances, identified by a frontend-generated UUID sent as `X-Session-ID` on every request, with automatic cleanup via `beforeunload` beacon and heartbeat TTL.

**Architecture:** Frontend generates `crypto.randomUUID()` on page load (stored in React memory via `SessionContext`), attaches it as `X-Session-ID` header on every API call. Backend `SessionManager` maps each UUID to a dedicated `Database` instance, destroyed on explicit cleanup or after 5 minutes without a heartbeat.

**Tech Stack:** Python 3.12, FastAPI, DuckDB, pytest + pytest-asyncio + httpx (new test deps), React 18, TypeScript

---

## Backend

### Task 1: Add test dependencies

**Files:**
- Modify: `backend/pyproject.toml`

**Step 1: Add pytest deps to pyproject.toml**

In `backend/pyproject.toml`, add a `[tool.poetry.dev-dependencies]` section after the existing `[tool.poetry.dependencies]` block:

```toml
[tool.poetry.dev-dependencies]
pytest = "^8.0"
pytest-asyncio = "^0.24"
httpx = "^0.28"
```

**Step 2: Install deps**

```bash
cd backend && poetry add --group dev pytest pytest-asyncio httpx
```

Expected: deps installed, `poetry.lock` updated.

**Step 3: Create tests directory**

```bash
mkdir -p backend/tests && touch backend/tests/__init__.py
```

**Step 4: Verify pytest runs (empty)**

```bash
cd backend && poetry run pytest tests/ -v
```

Expected: `no tests ran`, exit 0.

**Step 5: Commit**

```bash
git add backend/pyproject.toml backend/poetry.lock backend/tests/__init__.py
git commit -m "chore: add pytest/httpx test dependencies"
```

---

### Task 2: Create SessionManager

**Files:**
- Create: `backend/app/session_manager.py`
- Create: `backend/tests/test_session_manager.py`

**Step 1: Write failing tests**

Create `backend/tests/test_session_manager.py`:

```python
import time
from app.session_manager import SessionManager


def test_get_or_create_returns_database():
    mgr = SessionManager()
    db = mgr.get_or_create("abc")
    assert db is not None


def test_same_session_id_returns_same_instance():
    mgr = SessionManager()
    db1 = mgr.get_or_create("abc")
    db2 = mgr.get_or_create("abc")
    assert db1 is db2


def test_different_session_ids_return_different_instances():
    mgr = SessionManager()
    db1 = mgr.get_or_create("abc")
    db2 = mgr.get_or_create("xyz")
    assert db1 is not db2


def test_different_sessions_are_isolated():
    mgr = SessionManager()
    db1 = mgr.get_or_create("user1")
    db2 = mgr.get_or_create("user2")
    db1.execute_query("CREATE TABLE t1 (x INT)")
    tables1 = [t["name"] for t in db1.list_tables()]
    tables2 = [t["name"] for t in db2.list_tables()]
    assert "t1" in tables1
    assert "t1" not in tables2


def test_touch_returns_true_for_existing_session():
    mgr = SessionManager()
    mgr.get_or_create("abc")
    assert mgr.touch("abc") is True


def test_touch_returns_false_for_unknown_session():
    mgr = SessionManager()
    assert mgr.touch("unknown") is False


def test_destroy_removes_session():
    mgr = SessionManager()
    mgr.get_or_create("abc")
    mgr.destroy("abc")
    # After destroy, get_or_create creates a fresh instance
    db_new = mgr.get_or_create("abc")
    assert db_new.list_tables() == []


def test_cleanup_stale_removes_old_sessions():
    mgr = SessionManager()
    mgr.get_or_create("old")
    # Manually backdate last_seen_at
    from datetime import datetime, timedelta
    mgr._sessions["old"].last_seen_at = datetime.utcnow() - timedelta(seconds=400)
    removed = mgr.cleanup_stale(ttl_seconds=300)
    assert removed == 1
    assert "old" not in mgr._sessions


def test_cleanup_stale_keeps_recent_sessions():
    mgr = SessionManager()
    mgr.get_or_create("recent")
    removed = mgr.cleanup_stale(ttl_seconds=300)
    assert removed == 0
    assert "recent" in mgr._sessions
```

**Step 2: Run tests to confirm they fail**

```bash
cd backend && poetry run pytest tests/test_session_manager.py -v
```

Expected: `ImportError` — `session_manager` module doesn't exist yet.

**Step 3: Write `session_manager.py`**

Create `backend/app/session_manager.py`:

```python
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from app.database import Database

logger = logging.getLogger(__name__)


@dataclass
class SessionEntry:
    db: Database
    last_seen_at: datetime = field(default_factory=datetime.utcnow)


class SessionManager:
    def __init__(self) -> None:
        self._sessions: dict[str, SessionEntry] = {}

    def get_or_create(self, session_id: str) -> Database:
        if session_id not in self._sessions:
            logger.info("Creating new session: %s", session_id)
            self._sessions[session_id] = SessionEntry(db=Database())
        else:
            self._sessions[session_id].last_seen_at = datetime.utcnow()
        return self._sessions[session_id].db

    def touch(self, session_id: str) -> bool:
        if session_id not in self._sessions:
            return False
        self._sessions[session_id].last_seen_at = datetime.utcnow()
        return True

    def destroy(self, session_id: str) -> None:
        if session_id not in self._sessions:
            return
        try:
            self._sessions[session_id].db.conn.close()
        except Exception:
            pass
        del self._sessions[session_id]
        logger.info("Destroyed session: %s", session_id)

    def cleanup_stale(self, ttl_seconds: int = 300) -> int:
        cutoff = datetime.utcnow() - timedelta(seconds=ttl_seconds)
        stale = [
            sid for sid, entry in self._sessions.items()
            if entry.last_seen_at < cutoff
        ]
        for sid in stale:
            self.destroy(sid)
        return len(stale)


session_manager = SessionManager()
```

**Step 4: Run tests**

```bash
cd backend && poetry run pytest tests/test_session_manager.py -v
```

Expected: all 9 tests PASS.

**Step 5: Commit**

```bash
git add backend/app/session_manager.py backend/tests/test_session_manager.py
git commit -m "feat: add SessionManager for per-user DuckDB isolation"
```

---

### Task 3: Create FastAPI session dependency

**Files:**
- Create: `backend/app/dependencies.py`
- Create: `backend/tests/test_dependencies.py`

**Step 1: Write failing test**

Create `backend/tests/test_dependencies.py`:

```python
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.dependencies import get_session_db


def make_app():
    app = FastAPI()

    @app.get("/test-dep")
    async def test_route(db=Depends(get_session_db)):
        return {"tables": db.list_tables()}

    return app


# Import Depends here to avoid import errors at module level before the test
from fastapi import Depends


def test_missing_session_header_returns_400():
    client = TestClient(make_app(), raise_server_exceptions=False)
    response = client.get("/test-dep")
    assert response.status_code == 422  # FastAPI returns 422 for missing required header


def test_valid_session_header_returns_200():
    client = TestClient(make_app())
    response = client.get("/test-dep", headers={"X-Session-ID": "test-uuid"})
    assert response.status_code == 200
    assert response.json() == {"tables": []}


def test_two_different_sessions_are_isolated():
    from app.dependencies import get_session_db
    from app.session_manager import session_manager

    # Manually create two sessions
    db1 = session_manager.get_or_create("session-a")
    db2 = session_manager.get_or_create("session-b")
    db1.execute_query("CREATE TABLE only_in_a (x INT)")

    tables_a = [t["name"] for t in db1.list_tables()]
    tables_b = [t["name"] for t in db2.list_tables()]
    assert "only_in_a" in tables_a
    assert "only_in_a" not in tables_b

    # Cleanup
    session_manager.destroy("session-a")
    session_manager.destroy("session-b")
```

**Step 2: Run to confirm failure**

```bash
cd backend && poetry run pytest tests/test_dependencies.py -v
```

Expected: `ImportError` — `dependencies` module doesn't exist.

**Step 3: Write `dependencies.py`**

Create `backend/app/dependencies.py`:

```python
from fastapi import Header
from app.database import Database
from app.session_manager import session_manager


async def get_session_db(x_session_id: str = Header(...)) -> Database:
    return session_manager.get_or_create(x_session_id)
```

**Step 4: Run tests**

```bash
cd backend && poetry run pytest tests/test_dependencies.py -v
```

Expected: all 3 tests PASS.

**Step 5: Commit**

```bash
git add backend/app/dependencies.py backend/tests/test_dependencies.py
git commit -m "feat: add get_session_db FastAPI dependency"
```

---

### Task 4: Remove singleton from database.py

**Files:**
- Modify: `backend/app/database.py` (line 146–147)

**Step 1: Delete the singleton line**

In `backend/app/database.py`, remove lines 146–147:

```python
# Singleton instance
db = Database()
```

The file should end at line 144 (end of `load_sample_data` method).

**Step 2: Verify the import error shows up in dependents**

```bash
cd backend && python -c "from app.routes import tables" 2>&1 | head -5
```

Expected: `ImportError: cannot import name 'db' from 'app.database'` — confirms dependents need updating.

**Step 3: Commit**

```bash
git add backend/app/database.py
git commit -m "refactor: remove Database singleton — sessions handle instantiation"
```

---

### Task 5: Refactor tools.py to accept per-session db

**Files:**
- Modify: `backend/app/tools.py`

**Step 1: Rewrite `tools.py`**

Replace the entire contents of `backend/app/tools.py`:

```python
import json
from typing import Any
from claude_agent_sdk import tool, create_sdk_mcp_server
from app.database import Database

MAX_RESULT_ROWS = 100


def create_duckdb_server(db: Database):
    @tool(
        "execute_sql",
        "Execute a SQL query against the DuckDB database. Use this to query loaded tables, "
        "create views, or run any valid DuckDB SQL. Results are returned as JSON with columns, "
        "rows, and rowCount.",
        {"sql": str},
    )
    async def execute_sql(args: dict[str, Any]) -> dict[str, Any]:
        sql = args["sql"]
        try:
            result = db.execute_query(sql)
            truncated_rows = result["rows"][:MAX_RESULT_ROWS]
            result_json = {
                "status": "success",
                "columns": result["columns"],
                "rows": truncated_rows,
                "rowCount": result["rowCount"],
            }
            content_text = json.dumps(result_json, default=str)
            return {"content": [{"type": "text", "text": content_text}]}
        except Exception as e:
            error_json = {"status": "error", "error": str(e)}
            return {
                "content": [{"type": "text", "text": json.dumps(error_json)}],
                "is_error": True,
            }

    return create_sdk_mcp_server(
        name="duckdb",
        version="1.0.0",
        tools=[execute_sql],
    )
```

**Step 2: Verify import works**

```bash
cd backend && python -c "from app.tools import create_duckdb_server; print('ok')"
```

Expected: `ok`

**Step 3: Commit**

```bash
git add backend/app/tools.py
git commit -m "refactor: pass Database instance into create_duckdb_server via closure"
```

---

### Task 6: Refactor agent.py to accept per-session db

**Files:**
- Modify: `backend/app/agent.py`

**Step 1: Update `build_system_prompt` signature**

In `backend/app/agent.py`:

Change line 17 — remove `from app.database import db`.

Change the `build_system_prompt` function signature at line 46:

Old:
```python
def build_system_prompt(conversation_history: list[dict] | None = None) -> str:
    tables = db.list_tables()
```

New:
```python
def build_system_prompt(db: Database, conversation_history: list[dict] | None = None) -> str:
    from app.database import Database  # local import to avoid circular dep
    tables = db.list_tables()
```

Wait — `Database` is already importable from `app.database`. Just update the import at the top.

Here are all the changes to make to `agent.py`:

1. **Line 17**: Change `from app.database import db` → `from app.database import Database`

2. **Line 46**: Change function signature:
   ```python
   def build_system_prompt(db: Database, conversation_history: list[dict] | None = None) -> str:
   ```

3. **Line 96–100**: Change `stream_chat` signature:
   ```python
   async def stream_chat(
       message: str,
       session_id: str | None = None,
       db: Database | None = None,
       conversation_history: list[dict] | None = None,
   ) -> AsyncIterator[str]:
   ```

4. **Line 102**: Change `create_duckdb_server()` → `create_duckdb_server(db)`

5. **Line 112**: Change `build_system_prompt(conversation_history)` → `build_system_prompt(db, conversation_history)`

6. **Line 210**: The `db.execute_query(sql)` call in the `AssistantMessage` handler — already refers to the `db` parameter now.

The complete updated `stream_chat` signature and early lines:

```python
async def stream_chat(
    message: str,
    session_id: str | None = None,
    db: Database | None = None,
    conversation_history: list[dict] | None = None,
) -> AsyncIterator[str]:
    """Stream agent chat responses as SSE events."""
    if db is None:
        raise ValueError("db must be provided")
    duckdb_server = create_duckdb_server(db)
    ...
    options = ClaudeAgentOptions(
        ...
        system_prompt=build_system_prompt(db, conversation_history),
        ...
    )
```

**Step 2: Apply the edits using Edit tool** (see specific edits below)

Edit 1 — update import:
- Old: `from app.database import db`
- New: `from app.database import Database`

Edit 2 — update `build_system_prompt` signature:
- Old: `def build_system_prompt(conversation_history: list[dict] | None = None) -> str:`
- New: `def build_system_prompt(db: Database, conversation_history: list[dict] | None = None) -> str:`

Edit 3 — update `stream_chat` signature:
- Old:
```python
async def stream_chat(
    message: str,
    session_id: str | None = None,
    conversation_history: list[dict] | None = None,
) -> AsyncIterator[str]:
    """Stream agent chat responses as SSE events."""
    duckdb_server = create_duckdb_server()
```
- New:
```python
async def stream_chat(
    message: str,
    session_id: str | None = None,
    db: Database | None = None,
    conversation_history: list[dict] | None = None,
) -> AsyncIterator[str]:
    """Stream agent chat responses as SSE events."""
    if db is None:
        raise ValueError("db must be provided")
    duckdb_server = create_duckdb_server(db)
```

Edit 4 — update `build_system_prompt` call inside `stream_chat`:
- Old: `system_prompt=build_system_prompt(conversation_history),`
- New: `system_prompt=build_system_prompt(db, conversation_history),`

**Step 3: Verify import works**

```bash
cd backend && python -c "from app.agent import stream_chat; print('ok')"
```

Expected: `ok`

**Step 4: Commit**

```bash
git add backend/app/agent.py
git commit -m "refactor: pass Database instance into agent stream_chat and build_system_prompt"
```

---

### Task 7: Refactor routes/tables.py

**Files:**
- Modify: `backend/app/routes/tables.py`

**Step 1: Rewrite `tables.py`**

Replace the entire contents of `backend/app/routes/tables.py`:

```python
import os

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from app.config import MAX_TOTAL_SIZE_BYTES
from app.database import Database, SUPPORTED_EXTENSIONS
from app.dependencies import get_session_db

router = APIRouter(prefix="/api", tags=["tables"])


def sanitize_table_name(filename: str) -> str:
    return filename


@router.get("/tables")
async def list_tables(db: Database = Depends(get_session_db)):
    return db.list_tables()


@router.post("/upload")
async def upload_file(
    file: UploadFile = File(...),
    db: Database = Depends(get_session_db),
):
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file format. Supported: {', '.join(sorted(SUPPORTED_EXTENSIONS))}"
        )
    content = await file.read()
    if len(content) > MAX_TOTAL_SIZE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File size exceeds the {MAX_TOTAL_SIZE_BYTES // (1024 * 1024)}MB limit"
        )
    table_name = sanitize_table_name(file.filename)
    existing_tables = {t["name"] for t in db.list_tables()}
    if table_name in existing_tables:
        raise HTTPException(
            status_code=409,
            detail=f"A table named \"{table_name}\" already exists. Please remove it or rename the file before uploading."
        )
    try:
        results = db.load_file(content, file.filename, table_name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Failed to process file: {e}")
    if len(results) == 1:
        return results[0]
    return results


@router.post("/upload/sample")
async def load_sample(db: Database = Depends(get_session_db)):
    """Load the built-in Titanic sample dataset."""
    from pathlib import Path

    csv_path = Path(__file__).resolve().parent.parent / "data" / "titanic.csv"
    if not csv_path.exists():
        raise HTTPException(status_code=404, detail="Sample dataset not found")
    return db.load_sample_data(str(csv_path), "titanic")


@router.delete("/tables/{table_name:path}")
async def drop_table(table_name: str, db: Database = Depends(get_session_db)):
    db.drop_table(table_name)
    return {"ok": True}
```

**Step 2: Verify import**

```bash
cd backend && python -c "from app.routes.tables import router; print('ok')"
```

Expected: `ok`

**Step 3: Commit**

```bash
git add backend/app/routes/tables.py
git commit -m "refactor: inject per-session db into tables routes"
```

---

### Task 8: Refactor routes/query.py

**Files:**
- Modify: `backend/app/routes/query.py`

**Step 1: Rewrite `query.py`**

Replace the entire contents of `backend/app/routes/query.py`:

```python
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.database import Database
from app.dependencies import get_session_db

router = APIRouter(prefix="/api", tags=["query"])


class QueryRequest(BaseModel):
    sql: str


@router.post("/query")
async def execute_query(
    request: QueryRequest,
    db: Database = Depends(get_session_db),
):
    try:
        result = db.execute_query(request.sql)
        sql_lower = request.sql.strip().lower()
        result_type = "markdown" if sql_lower.startswith("explain") else "table"
        return {**result, "resultType": result_type}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
```

**Step 2: Verify**

```bash
cd backend && python -c "from app.routes.query import router; print('ok')"
```

Expected: `ok`

**Step 3: Commit**

```bash
git add backend/app/routes/query.py
git commit -m "refactor: inject per-session db into query route"
```

---

### Task 9: Refactor routes/chat.py

**Files:**
- Modify: `backend/app/routes/chat.py`

**Step 1: Rewrite `chat.py`**

Replace the entire contents of `backend/app/routes/chat.py`:

```python
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.agent import stream_chat
from app.database import Database
from app.dependencies import get_session_db

router = APIRouter(prefix="/api", tags=["chat"])


class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None


class ChatEditRequest(BaseModel):
    new_message: str
    conversation_history: list[dict] = []


@router.post("/chat")
async def chat(
    request: ChatRequest,
    db: Database = Depends(get_session_db),
):
    return StreamingResponse(
        stream_chat(request.message, request.session_id, db),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/chat/edit")
async def chat_edit(
    request: ChatEditRequest,
    db: Database = Depends(get_session_db),
):
    """Edit a message: start a fresh session with conversation history as context."""
    return StreamingResponse(
        stream_chat(
            request.new_message,
            session_id=None,
            db=db,
            conversation_history=request.conversation_history,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
```

**Step 2: Verify**

```bash
cd backend && python -c "from app.routes.chat import router; print('ok')"
```

Expected: `ok`

**Step 3: Commit**

```bash
git add backend/app/routes/chat.py
git commit -m "refactor: inject per-session db into chat routes"
```

---

### Task 10: Add session endpoints (heartbeat + cleanup)

**Files:**
- Create: `backend/app/routes/session.py`
- Create: `backend/tests/test_session_routes.py`

**Step 1: Write failing tests**

Create `backend/tests/test_session_routes.py`:

```python
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.session_manager import session_manager


@pytest.fixture(autouse=True)
def clean_sessions():
    """Clear all sessions before each test."""
    session_manager._sessions.clear()
    yield
    session_manager._sessions.clear()


client = TestClient(app)


def test_heartbeat_updates_existing_session():
    # First create a session via the tables endpoint
    r = client.get("/api/tables", headers={"X-Session-ID": "hb-test"})
    assert r.status_code == 200

    from datetime import datetime, timedelta
    # Backdate last_seen_at to simulate time passing
    session_manager._sessions["hb-test"].last_seen_at = datetime.utcnow() - timedelta(seconds=200)
    old_time = session_manager._sessions["hb-test"].last_seen_at

    r2 = client.post("/api/heartbeat", headers={"X-Session-ID": "hb-test"})
    assert r2.status_code == 200
    assert session_manager._sessions["hb-test"].last_seen_at > old_time


def test_heartbeat_unknown_session_returns_404():
    r = client.post("/api/heartbeat", headers={"X-Session-ID": "nonexistent"})
    assert r.status_code == 404


def test_cleanup_destroys_session():
    # Create session
    client.get("/api/tables", headers={"X-Session-ID": "cleanup-test"})
    assert "cleanup-test" in session_manager._sessions

    r = client.post("/api/session/cleanup?session_id=cleanup-test")
    assert r.status_code == 200
    assert "cleanup-test" not in session_manager._sessions


def test_cleanup_unknown_session_returns_200():
    r = client.post("/api/session/cleanup?session_id=does-not-exist")
    assert r.status_code == 200
```

**Step 2: Run to confirm failure**

```bash
cd backend && poetry run pytest tests/test_session_routes.py -v
```

Expected: `404` on heartbeat routes (not registered yet).

**Step 3: Create `session.py` route**

Create `backend/app/routes/session.py`:

```python
from fastapi import APIRouter, Header, Response

from app.session_manager import session_manager

router = APIRouter(prefix="/api", tags=["session"])


@router.post("/heartbeat")
async def heartbeat(x_session_id: str = Header(...)):
    found = session_manager.touch(x_session_id)
    if not found:
        return Response(status_code=404)
    return {"ok": True}


@router.post("/session/cleanup")
async def cleanup_session(session_id: str | None = None):
    if session_id:
        session_manager.destroy(session_id)
    return {"ok": True}
```

**Step 4: Register in main.py**

In `backend/app/main.py`, add import and `include_router`:

Add to imports:
```python
from app.routes import tables, query, chat, langfuse_status, config, session
```

Add after existing `app.include_router(config.router)`:
```python
app.include_router(session.router)
```

**Step 5: Run tests**

```bash
cd backend && poetry run pytest tests/test_session_routes.py -v
```

Expected: all 4 tests PASS.

**Step 6: Commit**

```bash
git add backend/app/routes/session.py backend/tests/test_session_routes.py backend/app/main.py
git commit -m "feat: add heartbeat and session cleanup endpoints"
```

---

### Task 11: Add background stale-session cleanup task

**Files:**
- Modify: `backend/app/main.py`

**Step 1: Add the startup background task**

In `backend/app/main.py`, add to the imports at the top:

```python
import asyncio
import logging

logger = logging.getLogger(__name__)
```

Add a lifespan function before `app = FastAPI(...)`:

```python
from contextlib import asynccontextmanager
from app.session_manager import session_manager


async def _cleanup_loop():
    while True:
        await asyncio.sleep(60)
        removed = session_manager.cleanup_stale(ttl_seconds=300)
        if removed:
            logger.info("Background cleanup: removed %d stale sessions", removed)


@asynccontextmanager
async def lifespan(app):
    task = asyncio.create_task(_cleanup_loop())
    yield
    task.cancel()


app = FastAPI(title="DuckDB Data Agent API", lifespan=lifespan)
```

(Remove `app = FastAPI(title="DuckDB Data Agent API")` if it was previously on its own line.)

**Step 2: Verify backend starts without error**

```bash
cd backend && poetry run python -c "from app.main import app; print('ok')"
```

Expected: `ok`

**Step 3: Commit**

```bash
git add backend/app/main.py
git commit -m "feat: add background task to clean up stale sessions after 5-minute TTL"
```

---

## Frontend

### Task 12: Create SessionContext

**Files:**
- Create: `frontend/src/contexts/SessionContext.tsx`
- Create: `frontend/src/hooks/useSessionId.ts`

**Step 1: Create `SessionContext.tsx`**

Create `frontend/src/contexts/SessionContext.tsx`:

```tsx
import { createContext, useEffect, useRef, type ReactNode } from 'react';

export const SessionContext = createContext<string>('');

export function SessionProvider({ children }: { children: ReactNode }) {
  const sessionIdRef = useRef<string>(crypto.randomUUID());

  useEffect(() => {
    const sessionId = sessionIdRef.current;

    const interval = setInterval(() => {
      fetch('/api/heartbeat', {
        method: 'POST',
        headers: { 'X-Session-ID': sessionId },
        keepalive: true,
      }).catch(() => {});
    }, 30_000);

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      navigator.sendBeacon(`/api/session/cleanup?session_id=${sessionId}`);
      e.preventDefault();
      e.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      clearInterval(interval);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  return (
    <SessionContext.Provider value={sessionIdRef.current}>
      {children}
    </SessionContext.Provider>
  );
}
```

**Step 2: Create `useSessionId.ts`**

Create `frontend/src/hooks/useSessionId.ts`:

```ts
import { useContext } from 'react';
import { SessionContext } from '../contexts/SessionContext';

export function useSessionId(): string {
  return useContext(SessionContext);
}
```

**Step 3: Wrap App in SessionProvider**

In `frontend/src/main.tsx`, update to:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { SessionProvider } from './contexts/SessionContext';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SessionProvider>
      <App />
    </SessionProvider>
  </StrictMode>
);
```

**Step 4: Verify TypeScript compiles**

```bash
cd frontend && npm run build 2>&1 | tail -10
```

Expected: build succeeds (or only pre-existing errors, none from new files).

**Step 5: Commit**

```bash
git add frontend/src/contexts/SessionContext.tsx frontend/src/hooks/useSessionId.ts frontend/src/main.tsx
git commit -m "feat: add SessionContext with UUID generation, heartbeat, and beforeunload cleanup"
```

---

### Task 13: Update agentService.ts to attach X-Session-ID

**Files:**
- Modify: `frontend/src/agent/agentService.ts`

**Step 1: Update `runAgentLoop` and `runAgentEditLoop`**

Both functions need to accept `sessionId: string` and pass it as a header.

In `runAgentLoop` (line 60), change signature and headers:

Old:
```ts
export async function runAgentLoop(
  message: string,
  sessionId: string | null,
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
```

New:
```ts
export async function runAgentLoop(
  message: string,
  agentSessionId: string | null,
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
  userSessionId?: string,
): Promise<void> {
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(userSessionId ? { 'X-Session-ID': userSessionId } : {}),
      },
```

Also update the body line (line 70):
Old: `body: JSON.stringify({ message, session_id: sessionId }),`
New: `body: JSON.stringify({ message, session_id: agentSessionId }),`

In `runAgentEditLoop` (line 88), update similarly:

Old:
```ts
export async function runAgentEditLoop(
  newMessage: string,
  conversationHistory: { role: string; content: string }[],
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const response = await fetch('/api/chat/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
```

New:
```ts
export async function runAgentEditLoop(
  newMessage: string,
  conversationHistory: { role: string; content: string }[],
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
  userSessionId?: string,
): Promise<void> {
  try {
    const response = await fetch('/api/chat/edit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(userSessionId ? { 'X-Session-ID': userSessionId } : {}),
      },
```

**Step 2: Verify TypeScript compiles**

```bash
cd frontend && npm run build 2>&1 | tail -10
```

Expected: build succeeds.

**Step 3: Commit**

```bash
git add frontend/src/agent/agentService.ts
git commit -m "feat: pass X-Session-ID header in agent SSE requests"
```

---

### Task 14: Update AgentContext.tsx to pass userSessionId

**Files:**
- Modify: `frontend/src/contexts/AgentContext.tsx`

**Step 1: Import and use `useSessionId`**

In `frontend/src/contexts/AgentContext.tsx`:

Add import at top:
```tsx
import { useSessionId } from '../hooks/useSessionId';
```

Inside `AgentProvider`, add after the existing refs:
```tsx
const userSessionId = useSessionId();
```

In `sendMessage` — update `runAgentLoop` call (currently around line 74):

Old:
```tsx
await runAgentLoop(
  text,
  sessionIdRef.current,
  { ... },
  controller.signal
);
```

New:
```tsx
await runAgentLoop(
  text,
  sessionIdRef.current,
  { ... },
  controller.signal,
  userSessionId,
);
```

In `editMessage` — update `runAgentEditLoop` call (currently around line 244):

Old:
```tsx
await runAgentEditLoop(
  newContent,
  conversationHistory,
  { ... },
  controller.signal
);
```

New:
```tsx
await runAgentEditLoop(
  newContent,
  conversationHistory,
  { ... },
  controller.signal,
  userSessionId,
);
```

**Step 2: Verify TypeScript compiles**

```bash
cd frontend && npm run build 2>&1 | tail -10
```

Expected: build succeeds.

**Step 3: Commit**

```bash
git add frontend/src/contexts/AgentContext.tsx
git commit -m "feat: pass user session ID from SessionContext into agent loops"
```

---

### Task 15: Update App.tsx to attach X-Session-ID to all fetch calls

**Files:**
- Modify: `frontend/src/App.tsx`

There are 8 `fetch` calls in `App.tsx` that need the `X-Session-ID` header. The `refreshTables` function also needs it, but note that `refreshTables` is defined inside the `App` component (not `AppContent`), so it needs access to `useSessionId` too.

**Step 1: Add `useSessionId` import and call in both `App` and `AppContent`**

In `frontend/src/App.tsx`:

Add import at top:
```tsx
import { useSessionId } from './hooks/useSessionId';
```

In `App` component (line 318), add `useSessionId`:
```tsx
export default function App() {
  const sessionId = useSessionId();
  const [tables, setTables] = useState<TableInfo[]>([]);
  ...
```

Update `refreshTables` in `App`:
Old:
```tsx
const response = await fetch('/api/tables');
```
New:
```tsx
const response = await fetch('/api/tables', {
  headers: { 'X-Session-ID': sessionId },
});
```

Update the health check fetch (no session needed — it's a health check, leave as-is).

In `AppContent`, add `sessionId` to props and pass from `App`:
```tsx
function AppContent({
  tables,
  refreshTables,
  sessionId,
}: {
  tables: TableInfo[];
  refreshTables: () => Promise<void>;
  sessionId: string;
})
```

Update all 6 remaining `fetch` calls in `AppContent` to include `'X-Session-ID': sessionId` header:

1. `handleLoadSample` — `fetch('/api/upload/sample', { method: 'POST', headers: { 'X-Session-ID': sessionId } })`

2. `handleFileUpload` — `fetch('/api/upload', { method: 'POST', headers: { 'X-Session-ID': sessionId }, body: formData })`
   Note: do NOT set `Content-Type` here — FormData sets it automatically with boundary.

3. `handleQueryExecute` — add `'X-Session-ID': sessionId` to existing headers.

4. `handleTableDelete` — `fetch('/api/tables/...', { method: 'DELETE', headers: { 'X-Session-ID': sessionId } })`

5. `handleDeleteAll` (loop) — same as above.

Update the `<AppContent>` render in `App` to pass `sessionId`:
```tsx
<AppContent tables={tables} refreshTables={refreshTables} sessionId={sessionId} />
```

**Step 2: Build to check TypeScript**

```bash
cd frontend && npm run build 2>&1 | tail -20
```

Expected: build succeeds with no new errors.

**Step 3: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat: attach X-Session-ID header to all API calls in App"
```

---

## Final Verification

### Task 16: End-to-end smoke test

**Step 1: Start the backend**

```bash
cd backend && poetry run uvicorn app.main:app --reload --port 8000
```

**Step 2: In a second terminal, start the frontend dev server**

```bash
cd frontend && npm run dev
```

**Step 3: Manual test checklist**

- [ ] Open `http://localhost:5173` — check Network tab, all API calls have `X-Session-ID` header
- [ ] Upload a CSV file — table appears in sidebar
- [ ] Open a second tab — sidebar shows no tables (isolated DuckDB)
- [ ] Close the first tab — browser shows "Leave site?" native confirmation dialog
- [ ] After confirming close, verify the heartbeat stops in the second tab's network monitor
- [ ] Wait for backend log showing stale session cleanup (after 5 min, or manually reduce TTL to test)

**Step 4: Run all backend tests**

```bash
cd backend && poetry run pytest tests/ -v
```

Expected: all tests PASS.

**Step 5: Final commit**

```bash
git add -A
git commit -m "feat: per-user DuckDB session isolation — complete implementation"
```
