# Memory Feature Design

## Overview

Add two types of persistent memory to the agent:

1. **Conversation memory** — persist chat history (messages + SQL results + chart specs) so users can browse, resume, and review past conversations via a sidebar UI.
2. **Agent memory** — store facts, preferences, and patterns as markdown files so the agent recalls context across sessions.

## Storage

**Conversation history: SQLite** at `data/memory.db` (configurable via `MEMORY_DB_PATH`).

**Agent memory: Markdown files** at `data/memories/{user_id}/MEMORY.md`.

## Data Model

### SQLite Schema

```sql
CREATE TABLE conversations (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL DEFAULT 'default',
  title      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,      -- 'user' | 'assistant'
  content         TEXT NOT NULL,
  metadata        TEXT,               -- JSON: {sql_queries: [...], chart_specs: [...]}
  created_at      TEXT NOT NULL,
  sort_order      INTEGER NOT NULL
);
```

- WAL mode for concurrent read/write.
- `user_id` defaults to `'default'` for single-user, ready for multi-user.
- CASCADE delete: removing a conversation deletes its messages.
- Schema created via `CREATE TABLE IF NOT EXISTS` on startup (no migration framework).

### Agent Memory File Format

```markdown
# Agent Memory

## Preferences
- User prefers bar charts over pie charts
- Always show row counts in SQL results

## Facts
- Sales database has tables: orders, customers, products
- Q4 2025 revenue was $2.3M

## Patterns
- User typically asks about sales trends on Mondays
```

## Backend API

### REST Endpoints (frontend sidebar)

```
GET    /api/conversations?user_id=default     -- List conversations (title, updated_at)
GET    /api/conversations/{id}                 -- Get conversation with all messages
POST   /api/conversations                      -- Create new conversation
PUT    /api/conversations/{id}                 -- Update title
DELETE /api/conversations/{id}                 -- Delete conversation + messages (CASCADE)
```

### Message Persistence

Integrated into the existing `stream_chat` flow — no separate message endpoints:

- On user message: save to SQLite.
- On stream done: save assistant response + metadata (SQL results, chart specs).
- Save failures are logged but don't break the chat stream.

### MCP Tools (agent memory)

```
save_memory(content, category)     -- Append a fact/preference/pattern to MEMORY.md
recall_memories(query?)            -- Read MEMORY.md contents (optional keyword filter)
forget_memory(content)             -- Remove a specific entry from MEMORY.md
```

### System Prompt Injection (hybrid retrieval)

- At conversation start, read `data/memories/{user_id}/MEMORY.md`.
- Append contents to system prompt under `## Agent Memory`.
- Agent also has `recall_memories` tool for on-demand retrieval.

### Auto-extraction

System prompt instruction tells the agent: "After answering, if the user expressed a preference or you learned an important fact about their data, use `save_memory` to store it." No separate extraction pipeline — agent decides what to remember.

## Frontend Changes

### Conversation Sidebar

- New `ConversationSidebar` component on the left side.
- Lists past conversations sorted by `updated_at` desc.
- Each entry: title (truncated), relative timestamp.
- Click to load conversation (fetch messages, populate chat).
- "New chat" button at top.
- Inline rename (click title to edit) and delete (with confirmation).

### Auto-titling

First user message truncated to ~50 chars or first sentence. No LLM call.

### Conversation Lifecycle

- Page load: fetch conversation list for sidebar, start with empty chat.
- First message: create conversation in backend, then stream as usual.
- Subsequent messages: append to existing conversation.
- Load past conversation: fetch messages, render in chat.

### State Management

- New `ConversationContext` wrapping the existing `AgentContext`.
- Holds: `conversations[]`, `activeConversationId`, CRUD methods.
- `AgentContext` modified to accept initial messages when loading a past conversation.

## Data Flow

```
NEW CONVERSATION:
User types message
  → Frontend: POST /api/conversations (create) → get conversation_id
  → Frontend: POST /api/chat (existing flow, + conversation_id header)
  → Backend: save user message to SQLite
  → Backend: read MEMORY.md → inject into system prompt
  → Backend: stream to sidecar (existing flow)
  → Sidecar: agent may call save_memory/recall_memories/forget_memory
  → Backend: on stream done → save assistant message + metadata to SQLite
  → Frontend: sidebar refreshes (new conversation appears with auto-title)

LOAD PAST CONVERSATION:
User clicks conversation in sidebar
  → Frontend: GET /api/conversations/{id} → messages[]
  → Frontend: populate chat with messages
  → User sends new message → appends to same conversation_id

AGENT MEMORY:
Agent auto-extracts → save_memory(content, category)
User says "remember X" → agent calls save_memory(X, 'user')
User says "forget X" → agent calls forget_memory(X)
Next conversation: MEMORY.md injected into system prompt
```

### Resume Constraint

Loading a past conversation restores UI messages but does NOT restore the sidecar's Claude SDK session. The agent starts fresh with conversation history passed as context (same as the existing resume-fallback mechanism).

## Error Handling

- **SQLite**: DB auto-created on startup. Write failures logged, don't break chat.
- **Agent memory files**: Directory created on first `save_memory`. `recall_memories` returns empty if file missing. `forget_memory` is no-op if entry not found.
- **Frontend**: Sidebar fetch failure shows empty list. Conversation load failure shows toast. Delete requires confirmation.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_DB_PATH` | `data/memory.db` | SQLite database path |
| `MEMORIES_DIR` | `data/memories` | Agent memory files directory |
