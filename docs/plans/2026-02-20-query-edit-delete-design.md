# Query Edit & Delete Design

## Problem

Users cannot modify or delete their messages in the agent chat. If a user sends a poorly worded query or wants to refine their question, they must send a new message, creating noise in the conversation. There is no way to "rewind" the conversation to an earlier state.

## Solution

Allow users to **edit** or **delete** their natural language messages in the agent chat:

- **Edit**: Replace a user message in-place, discard everything after it, and re-send the modified message for a fresh agent response
- **Delete**: Remove a user message and everything after it, rewinding the conversation to just before that point

## Architecture

### Approach: JSONL Session Truncation + Resume

The Claude Agent SDK stores conversation state as JSONL files at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. Each line is a JSON entry with types: `user`, `assistant`, `progress`, `system`, `file-history-snapshot`.

User query entries are identified by `type == "user"` with `message.content` as a string (tool result entries have array content).

To edit/delete a message:
1. Read the session JSONL file
2. Walk entries, counting user query entries to find the target index
3. Truncate the file at that entry (remove it and everything after)
4. For edit: resume the truncated session with the new message
5. For delete: return success

This preserves exact agent state up to the truncation point, as the SDK reconstructs conversation from the JSONL on resume.

## Data Flow

### Edit Flow

```
User hovers message -> clicks pencil icon -> message enters edit mode (textarea)
  -> user modifies text -> clicks "Save & Resend"
  -> Frontend: truncate messages array at edit index
  -> POST /api/chat/edit { session_id, user_message_index, new_message }
  -> Backend: truncate JSONL at Nth user query entry
  -> Backend: resume session with edited message, stream SSE response
  -> Frontend: receive SSE stream (same callbacks as normal chat)
  -> New assistant response appears
```

### Delete Flow

```
User hovers message -> clicks trash icon -> confirmation prompt
  -> POST /api/chat/delete { session_id, user_message_index }
  -> Backend: truncate JSONL at Nth user query entry
  -> Backend: return { ok: true }
  -> Frontend: truncate messages array at delete index
```

## Backend API

### POST /api/chat/edit

Request:
```python
class ChatEditRequest(BaseModel):
    session_id: str          # Current session ID
    user_message_index: int  # 0-based index of the user query to replace
    new_message: str         # The edited message text
```

Response: SSE stream (same format as `/api/chat`)

Logic:
1. Validate session_id exists as a JSONL file
2. Call `truncate_session(session_id, user_message_index)`
3. Call `stream_chat(new_message, session_id)` to resume and stream
4. Return SSE streaming response

### POST /api/chat/delete

Request:
```python
class ChatDeleteRequest(BaseModel):
    session_id: str          # Current session ID
    user_message_index: int  # 0-based index of the user query to delete from
```

Response: `{ "ok": true }`

Logic:
1. Validate session_id exists
2. Call `truncate_session(session_id, user_message_index)`
3. Return success

### Session Truncation Utility (backend/app/session.py)

```python
import json
import os
import tempfile
from pathlib import Path

def truncate_session(session_id: str, user_message_index: int) -> None:
    """Truncate session JSONL file, removing the Nth user query and everything after."""
    session_path = _get_session_path(session_id)
    if not session_path.exists():
        raise FileNotFoundError(f"Session file not found: {session_id}")

    with open(session_path, 'r') as f:
        lines = f.readlines()

    user_query_count = 0
    truncate_at = len(lines)

    for i, line in enumerate(lines):
        entry = json.loads(line)
        if _is_user_query(entry):
            if user_query_count == user_message_index:
                truncate_at = i
                break
            user_query_count += 1

    if truncate_at == len(lines):
        raise ValueError(f"User message index {user_message_index} not found")

    # Atomic write: write to temp file then rename
    dir_path = session_path.parent
    with tempfile.NamedTemporaryFile(mode='w', dir=dir_path, delete=False, suffix='.jsonl') as tmp:
        tmp.writelines(lines[:truncate_at])
        tmp_path = tmp.name
    os.replace(tmp_path, session_path)

def _is_user_query(entry: dict) -> bool:
    """Check if a JSONL entry is a user query (not a tool result)."""
    return (
        entry.get("type") == "user"
        and isinstance(entry.get("message", {}).get("content"), str)
    )

def _get_session_path(session_id: str) -> Path:
    """Construct path to session JSONL file."""
    cwd = os.getcwd()
    encoded = cwd.replace("/", "-")
    return Path.home() / ".claude" / "projects" / encoded / f"{session_id}.jsonl"
```

### Route Handler (backend/app/routes/chat.py)

Add `chat_edit` and `chat_delete` handlers alongside existing `chat` handler.

## Frontend Changes

### AgentContext.tsx

New callbacks exposed via context:

```typescript
editMessage(messageIndex: number, newContent: string): void
deleteMessage(messageIndex: number): void
```

**editMessage logic:**
1. Guard: if `isStreaming`, return
2. Compute `user_message_index` by counting user messages in `messages.slice(0, messageIndex)`
3. Truncate `messages` to `messages.slice(0, messageIndex)`
4. Create new user message with edited content + empty assistant message
5. Call `runAgentEditLoop` (posts to `/api/chat/edit`) with SSE callbacks
6. Stream response using existing SSE callback infrastructure

**deleteMessage logic:**
1. Guard: if `isStreaming`, return
2. Compute `user_message_index` by counting user messages in `messages.slice(0, messageIndex)`
3. POST to `/api/chat/delete` with `{ session_id, user_message_index }`
4. On success: truncate `messages` to `messages.slice(0, messageIndex)`
5. If `messageIndex === 0`, clear `sessionIdRef` (no session left)

### agentService.ts

New functions:

```typescript
function runAgentEditLoop(
  sessionId: string,
  userMessageIndex: number,
  newMessage: string,
  callbacks: AgentCallbacks,
  signal: AbortSignal
): void
// Same SSE parsing as runAgentLoop, posts to /api/chat/edit

async function deleteAgentMessage(
  sessionId: string,
  userMessageIndex: number
): Promise<void>
// Simple fetch POST to /api/chat/delete
```

### MessageBubble.tsx

**Hover actions on user messages:**
- Show pencil (edit) and trash (delete) icon buttons on hover
- Positioned at top-right of the user message bubble
- Hidden when `isStreaming` is true

**Edit mode:**
- Pencil click transforms message into editable textarea
- Pre-populated with current content, auto-focused
- "Save & Resend" (primary) and "Cancel" (secondary) buttons below
- Escape key cancels
- Save calls `editMessage(index, newText)`

**Delete confirmation:**
- Trash click shows inline confirmation: "Delete this and all following messages?"
- "Delete" (red) and "Cancel" buttons
- Confirm calls `deleteMessage(index)`

**Component structure:**
```
MessageBubble
  User message
    Static mode (default)
      Message text
      Hover overlay: [pencil] [trash]
    Edit mode (when editing)
      Textarea with current content
      [Save & Resend] [Cancel]
  Assistant message (unchanged)
```

## Error Handling

| Scenario | Backend | Frontend |
|----------|---------|----------|
| Session file not found | HTTP 404 | Show error message |
| Invalid message index | HTTP 400 | Should not happen (validated client-side) |
| Edit while streaming | N/A | Icons disabled during streaming |
| Concurrent request conflict | HTTP 409 | Show error message |
| JSONL write failure | Atomic write prevents corruption | Show error, no state change |
| Empty conversation after delete | N/A | Clear sessionIdRef, show empty chat |
| First message deleted | N/A | Reset to initial state |

## Files to Modify

### New Files
- `backend/app/session.py` — Session JSONL truncation utility

### Modified Files
- `backend/app/routes/chat.py` — Add edit/delete route handlers
- `backend/app/main.py` — Register new routes (if separate router)
- `frontend/src/agent/agentService.ts` — Add `runAgentEditLoop` and `deleteAgentMessage`
- `frontend/src/AgentContext.tsx` — Add `editMessage` and `deleteMessage` callbacks
- `frontend/src/components/MessageBubble.tsx` — Hover icons, edit mode, delete confirmation
- `frontend/src/types.ts` — Add request/response types if needed
