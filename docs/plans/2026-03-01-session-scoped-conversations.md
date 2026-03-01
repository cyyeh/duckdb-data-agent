# Session-Scoped Conversations Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make conversations ephemeral per browser session — lost on page refresh, matching how DuckDB tables already behave.

**Architecture:** Add `session_id` column to the `conversations` SQLite table. Filter listing by session_id, delete all session conversations on cleanup. Frontend sends `X-Session-ID` header on conversation API calls.

**Tech Stack:** Python/FastAPI (backend), React/TypeScript (frontend), SQLite

---

### Task 1: Add session_id column to memory_store schema

**Files:**
- Modify: `backend/app/memory_store.py:43-78` (schema init)

**Step 1: Add migration in `_init_schema`**

After the existing `CREATE TABLE` + `CREATE INDEX` block, add an `ALTER TABLE` migration (idempotent via try/except) and a new index:

```python
# In _init_schema, after conn.executescript(...):
# Migration: add session_id column
try:
    conn.execute(
        "ALTER TABLE conversations ADD COLUMN session_id TEXT NOT NULL DEFAULT ''"
    )
except sqlite3.OperationalError:
    pass  # column already exists
conn.execute(
    "CREATE INDEX IF NOT EXISTS idx_conversations_session "
    "ON conversations(session_id)"
)
conn.commit()
```

**Step 2: Verify manually**

Run: `cd backend && python -c "from app.memory_store import MemoryStore; m = MemoryStore('/tmp/test_migration.db'); print('OK')"`
Expected: `OK` (no errors)

**Step 3: Commit**

```bash
git add backend/app/memory_store.py
git commit -m "feat: add session_id column to conversations table"
```

---

### Task 2: Update memory_store methods to use session_id

**Files:**
- Modify: `backend/app/memory_store.py:84-109` (create_conversation)
- Modify: `backend/app/memory_store.py:111-131` (list_conversations)
- Add new method: `delete_conversations_by_session`

**Step 1: Update `create_conversation` signature and query**

```python
def create_conversation(
    self, user_id: str = "default", title: str | None = None,
    session_id: str = "",
) -> dict:
    now = _now_iso()
    conv_id = str(uuid.uuid4())
    row = {
        "id": conv_id,
        "user_id": user_id,
        "title": title,
        "session_id": session_id,
        "created_at": now,
        "updated_at": now,
    }
    with self._lock:
        conn = self._connect()
        try:
            conn.execute(
                """
                INSERT INTO conversations (id, user_id, title, session_id, created_at, updated_at)
                VALUES (:id, :user_id, :title, :session_id, :created_at, :updated_at)
                """,
                row,
            )
            conn.commit()
        finally:
            conn.close()
    return row
```

**Step 2: Update `list_conversations` to filter by session_id**

```python
def list_conversations(
    self,
    user_id: str = "default",
    limit: int = 50,
    offset: int = 0,
    session_id: str = "",
) -> list[dict]:
    with self._lock:
        conn = self._connect()
        try:
            rows = conn.execute(
                """
                SELECT * FROM conversations
                WHERE user_id = ? AND session_id = ?
                ORDER BY updated_at DESC
                LIMIT ? OFFSET ?
                """,
                (user_id, session_id, limit, offset),
            ).fetchall()
        finally:
            conn.close()
    return [dict(r) for r in rows]
```

**Step 3: Add `delete_conversations_by_session` method**

Add after `delete_conversation`:

```python
def delete_conversations_by_session(self, session_id: str) -> int:
    with self._lock:
        conn = self._connect()
        try:
            cur = conn.execute(
                "DELETE FROM conversations WHERE session_id = ?",
                (session_id,),
            )
            conn.commit()
            count = cur.rowcount
        finally:
            conn.close()
    return count
```

**Step 4: Commit**

```bash
git add backend/app/memory_store.py
git commit -m "feat: session_id support in memory_store create/list/delete"
```

---

### Task 3: Update conversation routes to pass session_id

**Files:**
- Modify: `backend/app/routes/conversations.py`

**Step 1: Update imports and request model**

Add `Header` to FastAPI imports. Add `session_id` to `CreateConversationRequest`:

```python
from fastapi import APIRouter, Header, Query
```

**Step 2: Update `list_conversations` endpoint**

```python
@router.get("")
async def list_conversations(
    user_id: str = Query("default"),
    limit: int = Query(50),
    offset: int = Query(0),
    x_session_id: str = Header(""),
):
    return memory_store.list_conversations(
        user_id=user_id, limit=limit, offset=offset, session_id=x_session_id,
    )
```

**Step 3: Update `create_conversation` endpoint**

```python
@router.post("")
async def create_conversation(
    request: CreateConversationRequest,
    x_session_id: str = Header(""),
):
    return memory_store.create_conversation(
        user_id=request.user_id, title=request.title, session_id=x_session_id,
    )
```

**Step 4: Commit**

```bash
git add backend/app/routes/conversations.py
git commit -m "feat: pass session_id from header in conversation routes"
```

---

### Task 4: Clean up conversations on session destroy

**Files:**
- Modify: `backend/app/routes/session.py`

**Step 1: Import memory_store and call cleanup**

```python
from app.memory_store import memory_store
```

In `cleanup_session`, after `session_manager.destroy(effective_id)`, add:

```python
if effective_id:
    session_manager.destroy(effective_id)
    memory_store.delete_conversations_by_session(effective_id)
```

**Step 2: Commit**

```bash
git add backend/app/routes/session.py
git commit -m "feat: delete session conversations on session cleanup"
```

---

### Task 5: Frontend — send X-Session-ID on conversation API calls

**Files:**
- Modify: `frontend/src/contexts/ConversationContext.tsx`
- Modify: `frontend/src/components/ConversationHistory.tsx`

**Step 1: Update ConversationContext to accept and use sessionId**

Change the provider to accept `sessionId` prop and include it in headers:

```typescript
export function ConversationProvider({ children, sessionId }: { children: ReactNode; sessionId: string }) {
```

Update `createConversation`:

```typescript
const createConversation = useCallback(async (firstMessage: string): Promise<string> => {
    const title = firstMessage.length > 50 ? firstMessage.slice(0, 50) + '...' : firstMessage;
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-ID': sessionId },
      body: JSON.stringify({ title }),
    });
    const conv = await res.json();
    setActiveConversationId(conv.id);
    triggerRefresh();
    return conv.id;
  }, [triggerRefresh, sessionId]);
```

**Step 2: Update ConversationHistory to accept and use sessionId**

Add `sessionId` to props interface and send it in fetch:

```typescript
interface ConversationHistoryProps {
  activeConversationId: string | null;
  onSelect: (conversationId: string) => void;
  onNew: () => void;
  onDelete: (conversationId: string) => void;
  onRename: (conversationId: string, title: string) => void;
  refreshTrigger: number;
  sessionId: string;
}
```

Update `fetchConversations`:

```typescript
const fetchConversations = useCallback(async () => {
    try {
      const res = await fetch('/api/conversations', {
        headers: { 'X-Session-ID': sessionId },
      });
      if (res.ok) {
        setConversations(await res.json());
      }
    } catch {
      // Sidebar fetch failure: show empty list
    }
  }, [sessionId]);
```

**Step 3: Wire sessionId through App.tsx and Sidebar**

In `App.tsx`, pass `sessionId` to `ConversationProvider`:

```typescript
<ConversationProvider sessionId={sessionId}>
```

In `Sidebar.tsx`, add `sessionId` to props and pass to `ConversationHistory`:

```typescript
// SidebarProps: add sessionId: string
// Pass to ConversationHistory: sessionId={sessionId}
```

In `AppContent`, pass `sessionId` to `Sidebar`:

```typescript
<Sidebar
  ...existing props...
  sessionId={sessionId}
/>
```

**Step 4: Commit**

```bash
git add frontend/src/contexts/ConversationContext.tsx frontend/src/components/ConversationHistory.tsx frontend/src/components/Sidebar.tsx frontend/src/App.tsx
git commit -m "feat: send X-Session-ID header on conversation API calls"
```

---

### Task 6: Write backend tests

**Files:**
- Create: `backend/tests/test_memory_store.py`

**Step 1: Write tests for session-scoped behavior**

```python
import os
import pytest
from app.memory_store import MemoryStore


@pytest.fixture
def store(tmp_path):
    db_path = str(tmp_path / "test.db")
    return MemoryStore(db_path)


def test_create_conversation_with_session_id(store):
    conv = store.create_conversation(session_id="sess-1", title="hello")
    assert conv["session_id"] == "sess-1"
    assert conv["title"] == "hello"


def test_list_conversations_filters_by_session(store):
    store.create_conversation(session_id="sess-1", title="a")
    store.create_conversation(session_id="sess-2", title="b")
    store.create_conversation(session_id="sess-1", title="c")

    result = store.list_conversations(session_id="sess-1")
    assert len(result) == 2
    titles = {r["title"] for r in result}
    assert titles == {"a", "c"}

    result2 = store.list_conversations(session_id="sess-2")
    assert len(result2) == 1
    assert result2[0]["title"] == "b"


def test_delete_conversations_by_session(store):
    store.create_conversation(session_id="sess-1", title="a")
    c2 = store.create_conversation(session_id="sess-2", title="b")
    store.create_conversation(session_id="sess-1", title="c")
    store.add_message(c2["id"], "user", "hi")

    deleted = store.delete_conversations_by_session("sess-1")
    assert deleted == 2

    # sess-2 untouched
    remaining = store.list_conversations(session_id="sess-2")
    assert len(remaining) == 1
    assert remaining[0]["title"] == "b"
    # messages for sess-2 still intact
    msgs = store.list_messages(c2["id"])
    assert len(msgs) == 1


def test_delete_conversations_by_session_cascades_messages(store):
    conv = store.create_conversation(session_id="sess-x", title="t")
    store.add_message(conv["id"], "user", "hello")
    store.add_message(conv["id"], "assistant", "world")

    store.delete_conversations_by_session("sess-x")

    # Conversation gone
    assert store.get_conversation(conv["id"]) is None
    # Messages also gone
    assert store.list_messages(conv["id"]) == []
```

**Step 2: Run tests**

Run: `cd backend && python -m pytest tests/test_memory_store.py -v`
Expected: All 4 tests PASS

**Step 3: Commit**

```bash
git add backend/tests/test_memory_store.py
git commit -m "test: session-scoped conversation tests for memory_store"
```
