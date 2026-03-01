# Session-Scoped Conversations Design

## Problem

Conversations persist in SQLite across page refreshes, but DuckDB tables are session-scoped and lost on refresh. This creates a mismatch: old conversations reference tables that no longer exist.

## Decision

Make conversations session-scoped (ephemeral), matching the DuckDB table lifecycle. Keep SQLite for within-session reliability (stream recovery, conversation switching), but delete all conversations when the session ends.

## Approach

Add `session_id` column to the `conversations` table and filter/cleanup by it.

### Data Model

- Add `session_id TEXT DEFAULT ''` to `conversations` table
- Add index on `session_id` for efficient filtering and cleanup
- Schema migration via `ALTER TABLE ADD COLUMN` in `_init_schema()`

### Backend Changes

**`memory_store.py`:**
- `create_conversation(session_id, ...)` — store session_id
- `list_conversations(session_id, ...)` — filter by session_id
- `delete_conversations_by_session(session_id)` — new method, deletes all conversations + messages (CASCADE) for a session

**`routes/conversations.py`:**
- `POST /api/conversations` — read `X-Session-ID` header, pass to create
- `GET /api/conversations` — read `X-Session-ID` header, pass to list filter

**`routes/session.py`:**
- `cleanup_session()` — call `memory_store.delete_conversations_by_session(session_id)` alongside DuckDB cleanup

### Frontend Changes

**`ConversationContext.tsx`:**
- Accept `sessionId` (from `useSessionId()`) and include `X-Session-ID` header in create calls

**`ConversationHistory.tsx`:**
- Include `X-Session-ID` header when fetching conversation list

### Cleanup Flow

1. User closes/refreshes tab → `beforeunload` fires
2. `sendBeacon` to `/api/session/cleanup` with session_id
3. Backend destroys DuckDB session AND deletes all conversations for that session
4. SQLite CASCADE deletes all associated messages
