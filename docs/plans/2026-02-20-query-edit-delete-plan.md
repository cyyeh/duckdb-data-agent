# Query Edit & Delete Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow users to edit or delete their natural language messages in the agent chat, rewinding conversation state and session history accordingly.

**Architecture:** JSONL session truncation approach — when editing/deleting, we truncate the Claude Agent SDK's session JSONL file at the target user message, then resume for edits. Backend gets two new endpoints (`/api/chat/edit`, `/api/chat/delete`) and a session truncation utility. Frontend adds hover actions on user messages, inline edit mode, and delete confirmation.

**Tech Stack:** Python/FastAPI (backend), React/TypeScript (frontend), Claude Agent SDK JSONL session files

**Design doc:** `docs/plans/2026-02-20-query-edit-delete-design.md`

---

### Task 1: Create session truncation utility

**Files:**
- Create: `backend/app/session.py`

**Step 1: Write the session utility**

Create `backend/app/session.py` with the following:

```python
import json
import os
import tempfile
from pathlib import Path


def truncate_session(session_id: str, user_message_index: int) -> None:
    """Truncate session JSONL file, removing the Nth user query and everything after.

    Args:
        session_id: The Claude session UUID.
        user_message_index: 0-based index of the user query to truncate from.

    Raises:
        FileNotFoundError: If the session JSONL file does not exist.
        ValueError: If the user_message_index is out of range.
    """
    session_path = get_session_path(session_id)
    if not session_path.exists():
        raise FileNotFoundError(f"Session file not found: {session_id}")

    with open(session_path, "r") as f:
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
        raise ValueError(f"User message index {user_message_index} not found in session {session_id}")

    # Atomic write: write to temp file then rename to prevent corruption
    dir_path = session_path.parent
    with tempfile.NamedTemporaryFile(
        mode="w", dir=dir_path, delete=False, suffix=".jsonl"
    ) as tmp:
        tmp.writelines(lines[:truncate_at])
        tmp_path = tmp.name
    os.replace(tmp_path, session_path)


def _is_user_query(entry: dict) -> bool:
    """Check if a JSONL entry is a user query (not a tool result).

    User queries have type="user" and message.content as a string.
    Tool result entries have message.content as a list of objects.
    """
    return entry.get("type") == "user" and isinstance(
        entry.get("message", {}).get("content"), str
    )


def get_session_path(session_id: str) -> Path:
    """Construct path to session JSONL file.

    The Claude Agent SDK stores sessions at:
    ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl

    Where <encoded-cwd> replaces "/" with "-" in the current working directory.
    """
    cwd = os.getcwd()
    encoded = cwd.replace("/", "-")
    return Path.home() / ".claude" / "projects" / encoded / f"{session_id}.jsonl"
```

**Step 2: Verify the file**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent && python -c "from backend.app.session import truncate_session, get_session_path; print('import ok')"`

Expected: `import ok` (no syntax errors)

**Step 3: Commit**

```bash
git add backend/app/session.py
git commit -m "feat: add session JSONL truncation utility"
```

---

### Task 2: Add backend edit and delete endpoints

**Files:**
- Modify: `backend/app/routes/chat.py` (all lines, currently 26 lines)

**Step 1: Add edit and delete routes**

Replace the full contents of `backend/app/routes/chat.py` with:

```python
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.agent import stream_chat
from app.session import truncate_session

router = APIRouter(prefix="/api", tags=["chat"])


class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None


class ChatEditRequest(BaseModel):
    session_id: str
    user_message_index: int
    new_message: str


class ChatDeleteRequest(BaseModel):
    session_id: str
    user_message_index: int


@router.post("/chat")
async def chat(request: ChatRequest):
    return StreamingResponse(
        stream_chat(request.message, request.session_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/chat/edit")
async def chat_edit(request: ChatEditRequest):
    try:
        truncate_session(request.session_id, request.user_message_index)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Session not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return StreamingResponse(
        stream_chat(request.new_message, request.session_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/chat/delete")
async def chat_delete(request: ChatDeleteRequest):
    try:
        truncate_session(request.session_id, request.user_message_index)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Session not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {"ok": True}
```

**Step 2: Verify no import errors**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent/backend && python -c "from app.routes.chat import router; print('routes ok')"`

Expected: `routes ok`

**Step 3: Commit**

```bash
git add backend/app/routes/chat.py
git commit -m "feat: add /api/chat/edit and /api/chat/delete endpoints"
```

---

### Task 3: Add frontend agent service functions

**Files:**
- Modify: `frontend/src/agent/agentService.ts` (all 122 lines)

**Step 1: Add runAgentEditLoop and deleteAgentMessage**

Add two new exported functions after the existing `runAgentLoop` function (after line 72, before the `handleSSEEvent` function). The `runAgentEditLoop` function reuses the same SSE parsing logic but posts to `/api/chat/edit` with different request body. The `deleteAgentMessage` function is a simple fetch POST.

After line 72 (after the closing `}` of `runAgentLoop`), add:

```typescript
export async function runAgentEditLoop(
  sessionId: string,
  userMessageIndex: number,
  newMessage: string,
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const response = await fetch('/api/chat/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        user_message_index: userMessageIndex,
        new_message: newMessage,
      }),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      callbacks.onError(`Server error: ${errorText}`);
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      callbacks.onError('No response stream');
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      let eventType = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          const data = line.slice(6);
          try {
            const parsed = JSON.parse(data);
            handleSSEEvent(eventType, parsed, callbacks);
          } catch {
            // Skip malformed JSON
          }
          eventType = '';
        }
      }
    }
  } catch (e: unknown) {
    if (signal?.aborted) return;
    const msg = e instanceof Error ? e.message : 'Connection failed';
    callbacks.onError(msg);
  }
}

export async function deleteAgentMessage(
  sessionId: string,
  userMessageIndex: number,
): Promise<void> {
  const response = await fetch('/api/chat/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,
      user_message_index: userMessageIndex,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Delete failed: ${errorText}`);
  }
}
```

**Step 2: Verify TypeScript compilation**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent/frontend && npx tsc --noEmit`

Expected: No errors

**Step 3: Commit**

```bash
git add frontend/src/agent/agentService.ts
git commit -m "feat: add agent service functions for edit and delete"
```

---

### Task 4: Add editMessage and deleteMessage to AgentContext

**Files:**
- Modify: `frontend/src/AgentContext.tsx` (all 243 lines)

**Step 1: Update AgentContextValue interface**

At `AgentContext.tsx:12-17`, add `editMessage` and `deleteMessage` to the interface:

```typescript
interface AgentContextValue {
  messages: ChatMessage[];
  isStreaming: boolean;
  sendMessage: (text: string) => void;
  editMessage: (messageIndex: number, newContent: string) => void;
  deleteMessage: (messageIndex: number) => void;
  clearMessages: () => void;
}
```

Update the default context at lines 19-24:

```typescript
const AgentContext = createContext<AgentContextValue>({
  messages: [],
  isStreaming: false,
  sendMessage: () => {},
  editMessage: () => {},
  deleteMessage: () => {},
  clearMessages: () => {},
});
```

**Step 2: Add import for new service functions**

At line 9, update the import to include the new functions:

```typescript
import { runAgentLoop, runAgentEditLoop, deleteAgentMessage } from './agent/agentService';
```

**Step 3: Add helper function to count user messages**

Add this helper inside the `AgentProvider` function, after the ref declarations (after line 46):

```typescript
const getUserMessageIndex = useCallback((messageIndex: number) => {
  // Count user messages before this index in the messages array
  let count = 0;
  for (let i = 0; i < messageIndex; i++) {
    if (messages[i].role === 'user') count++;
  }
  return count;
}, [messages]);
```

**Step 4: Add editMessage callback**

Add this after the `sendMessage` callback (after line 220), before `clearMessages`:

```typescript
const editMessage = useCallback(
  async (messageIndex: number, newContent: string) => {
    if (isStreaming) return;
    if (!sessionIdRef.current) return;

    const userMsgIndex = getUserMessageIndex(messageIndex);

    // Truncate messages and add new user + assistant messages
    const assistantId = generateId();
    assistantIdRef.current = assistantId;

    const userMsg: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: newContent,
    };
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      toolCalls: [],
      isStreaming: true,
    };

    setMessages((prev) => [...prev.slice(0, messageIndex), userMsg, assistantMsg]);
    setIsStreaming(true);
    textBufferRef.current = '';
    segmentsRef.current = [];
    currentTextRef.current = '';

    const controller = new AbortController();
    abortRef.current = controller;

    await runAgentEditLoop(
      sessionIdRef.current,
      userMsgIndex,
      newContent,
      {
        onTextChunk: (chunk) => {
          textBufferRef.current += chunk;
          if (!flushTimerRef.current) {
            flushTimerRef.current = setTimeout(() => {
              flushText();
              flushTimerRef.current = null;
            }, 50);
          }
        },
        onThinkingDone: () => {
          if (flushTimerRef.current) {
            clearTimeout(flushTimerRef.current);
            flushTimerRef.current = null;
          }
          flushText();
          if (currentTextRef.current.trim()) {
            segmentsRef.current.push({ type: 'thinking', text: currentTextRef.current });
            currentTextRef.current = '';
          }
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, currentPhase: 'answer', segments: [...segmentsRef.current] }
                : m
            )
          );
        },
        onToolCall: (pending: ToolCallResult) => {
          if (flushTimerRef.current) {
            clearTimeout(flushTimerRef.current);
            flushTimerRef.current = null;
          }
          flushText();
          if (currentTextRef.current.trim()) {
            segmentsRef.current.push({ type: 'thinking', text: currentTextRef.current });
            currentTextRef.current = '';
          }
          segmentsRef.current.push({ type: 'tool', toolResult: pending });
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, segments: [...segmentsRef.current] }
                : m
            )
          );
        },
        onToolResult: (result: ToolCallResult) => {
          const pendingIdx = segmentsRef.current.findIndex(
            (s) => s.type === 'tool' && s.toolResult?.toolCallId === result.toolCallId
          );
          if (pendingIdx !== -1) {
            const pending = segmentsRef.current[pendingIdx].toolResult!;
            segmentsRef.current[pendingIdx] = {
              type: 'tool',
              toolResult: {
                ...pending,
                ...result,
                toolName: result.toolName || pending.toolName,
                command: result.command || pending.command,
                toolInput: result.toolInput || pending.toolInput,
              },
            };
          } else {
            segmentsRef.current.push({ type: 'tool', toolResult: result });
          }
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, toolCalls: [...(m.toolCalls || []), result], segments: [...segmentsRef.current] }
                : m
            )
          );
          refreshTables();
        },
        onDone: (newSessionId) => {
          if (newSessionId) sessionIdRef.current = newSessionId;
          if (flushTimerRef.current) {
            clearTimeout(flushTimerRef.current);
            flushTimerRef.current = null;
          }
          flushText();
          if (currentTextRef.current.trim()) {
            segmentsRef.current.push({ type: 'answer', text: currentTextRef.current });
            currentTextRef.current = '';
          }
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, isStreaming: false, currentPhase: undefined, segments: [...segmentsRef.current] }
                : m
            )
          );
          setIsStreaming(false);
          abortRef.current = null;
        },
        onError: (error) => {
          if (flushTimerRef.current) {
            clearTimeout(flushTimerRef.current);
            flushTimerRef.current = null;
          }
          flushText();
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: m.content + `\n\n**Error:** ${error}`, isStreaming: false }
                : m
            )
          );
          setIsStreaming(false);
          abortRef.current = null;
        },
      },
      controller.signal
    );
  },
  [isStreaming, messages, flushText, refreshTables, getUserMessageIndex]
);
```

**Step 5: Add deleteMessage callback**

Add this after `editMessage`, before `clearMessages`:

```typescript
const deleteMessage = useCallback(
  async (messageIndex: number) => {
    if (isStreaming) return;

    // If we have a session, truncate the backend session file
    if (sessionIdRef.current) {
      const userMsgIndex = getUserMessageIndex(messageIndex);
      try {
        await deleteAgentMessage(sessionIdRef.current, userMsgIndex);
      } catch (e) {
        console.error('Failed to delete message:', e);
        return;
      }
    }

    // Truncate frontend messages
    setMessages((prev) => prev.slice(0, messageIndex));

    // If deleting the first message, clear session
    if (messageIndex === 0) {
      sessionIdRef.current = null;
    }
  },
  [isStreaming, messages, getUserMessageIndex]
);
```

**Step 6: Update context provider value**

At line 233, update the value prop to include the new callbacks:

```typescript
value={{ messages, isStreaming, sendMessage, editMessage, deleteMessage, clearMessages }}
```

**Step 7: Verify TypeScript compilation**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent/frontend && npx tsc --noEmit`

Expected: No errors

**Step 8: Commit**

```bash
git add frontend/src/AgentContext.tsx
git commit -m "feat: add editMessage and deleteMessage to AgentContext"
```

---

### Task 5: Add hover actions and edit/delete UI to MessageBubble

**Files:**
- Modify: `frontend/src/components/MessageBubble.tsx` (all 155 lines)
- Modify: `frontend/src/components/MessageBubble.css` (all 249 lines)
- Modify: `frontend/src/components/AgentPanel.tsx:51-53` (pass index to MessageBubble)

**Step 1: Update AgentPanel to pass message index**

In `frontend/src/components/AgentPanel.tsx`, at lines 51-53, update the message rendering to pass the index:

Change:
```tsx
{messages.map((msg) => (
  <MessageBubble key={msg.id} message={msg} />
))}
```

To:
```tsx
{messages.map((msg, index) => (
  <MessageBubble key={msg.id} message={msg} messageIndex={index} />
))}
```

**Step 2: Update MessageBubble component**

Replace the `MessageBubble` export in `frontend/src/components/MessageBubble.tsx` (lines 74-154) with the version below. This adds:
- `messageIndex` prop
- Local state for `isEditing` and `isConfirmingDelete`
- Hover action icons
- Inline edit textarea
- Delete confirmation

Replace lines 74-154 with:

```tsx
export function MessageBubble({ message, messageIndex }: { message: ChatMessage; messageIndex: number }) {
  const { isStreaming, editMessage, deleteMessage } = useAgent();
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(message.content);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isUser = message.role === 'user';
  const hasSegments = !isUser && message.segments && message.segments.length > 0;

  // Auto-focus textarea when entering edit mode
  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.selectionStart = textareaRef.current.value.length;
    }
  }, [isEditing]);

  const handleEdit = () => {
    setEditText(message.content);
    setIsEditing(true);
    setIsConfirmingDelete(false);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditText(message.content);
  };

  const handleSaveEdit = () => {
    const trimmed = editText.trim();
    if (!trimmed || trimmed === message.content) {
      handleCancelEdit();
      return;
    }
    setIsEditing(false);
    editMessage(messageIndex, trimmed);
  };

  const handleDeleteConfirm = () => {
    setIsConfirmingDelete(false);
    deleteMessage(messageIndex);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      handleCancelEdit();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSaveEdit();
    }
  };

  // Compute streaming remainder text
  let streamingRemainder: string | undefined;
  if (hasSegments && message.isStreaming && message.content) {
    const segmentedText = message.segments!
      .filter((s) => s.type !== 'tool')
      .map((s) => s.text || '')
      .join('');
    const remaining = message.content.slice(segmentedText.length);
    if (remaining.trim()) {
      streamingRemainder = remaining;
    }
  }

  const hasAnswer = hasSegments && message.segments!.some((s) => s.type === 'answer');
  const isInAnswerPhase = message.currentPhase === 'answer';
  const isThinkingPhase = !!message.isStreaming && !hasAnswer && !isInAnswerPhase;

  const answerSegments = hasSegments
    ? message.segments!.filter((s) => s.type === 'answer' && s.text?.trim())
    : [];

  return (
    <div className={`message-bubble message-bubble--${message.role}`}>
      <div className="message-bubble__header">
        {isUser ? 'You' : 'Assistant'}
        {isUser && !isStreaming && !isEditing && !isConfirmingDelete && (
          <span className="message-bubble__actions">
            <button
              className="message-bubble__action-btn"
              onClick={handleEdit}
              title="Edit message"
            >
              &#9998;
            </button>
            <button
              className="message-bubble__action-btn message-bubble__action-btn--delete"
              onClick={() => setIsConfirmingDelete(true)}
              title="Delete message"
            >
              &#128465;
            </button>
          </span>
        )}
      </div>

      {isUser && isConfirmingDelete && (
        <div className="message-bubble__confirm-delete">
          <span>Delete this and all following messages?</span>
          <div className="message-bubble__confirm-actions">
            <button
              className="message-bubble__confirm-btn message-bubble__confirm-btn--delete"
              onClick={handleDeleteConfirm}
            >
              Delete
            </button>
            <button
              className="message-bubble__confirm-btn"
              onClick={() => setIsConfirmingDelete(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {isUser && isEditing ? (
        <div className="message-bubble__edit-mode">
          <textarea
            ref={textareaRef}
            className="message-bubble__edit-textarea"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={3}
          />
          <div className="message-bubble__edit-actions">
            <button
              className="message-bubble__edit-btn message-bubble__edit-btn--save"
              onClick={handleSaveEdit}
            >
              Save &amp; Resend
            </button>
            <button
              className="message-bubble__edit-btn"
              onClick={handleCancelEdit}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : hasSegments ? (
        <div className="message-bubble__segments">
          <ThinkingBlock
            segments={message.segments!}
            streamingRemainder={isThinkingPhase ? streamingRemainder : undefined}
            isActivelyStreaming={isThinkingPhase}
          />
          {answerSegments.map((seg, i) => (
            <div key={i} className="message-bubble__segment message-bubble__segment--answer">
              <div className="message-bubble__segment-label message-bubble__segment-label--answer">Answer</div>
              <div className="message-bubble__segment-content">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{seg.text!}</ReactMarkdown>
              </div>
            </div>
          ))}
          {isInAnswerPhase && !hasAnswer && streamingRemainder?.trim() && (
            <div className="message-bubble__segment message-bubble__segment--answer">
              <div className="message-bubble__segment-label message-bubble__segment-label--answer">Answer</div>
              <div className="message-bubble__segment-content">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingRemainder}</ReactMarkdown>
              </div>
            </div>
          )}
          {message.isStreaming && !message.content && (
            <span className="message-bubble__typing">Thinking...</span>
          )}
        </div>
      ) : (
        <>
          <div className="message-bubble__content">
            {message.content ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
            ) : message.isStreaming ? (
              <span className="message-bubble__typing">Thinking...</span>
            ) : null}
          </div>
          {message.toolCalls && message.toolCalls.length > 0 && (
            <div className="message-bubble__tools">
              {message.toolCalls.map((tc) => (
                <InlineQueryResult key={tc.toolCallId} result={tc} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

**Step 3: Add imports at the top of MessageBubble.tsx**

Update the imports at line 1-5 of `MessageBubble.tsx`. Add `useState`, `useRef`, `useEffect` from React and `useAgent` from context:

```tsx
import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage, ContentSegment } from '../types';
import { useAgent } from '../AgentContext';
import { InlineQueryResult } from './InlineQueryResult';
import './MessageBubble.css';
```

**Step 4: Add CSS for hover actions, edit mode, and delete confirmation**

Append the following to `frontend/src/components/MessageBubble.css` (after line 249):

```css
/* Hover actions for user messages */
.message-bubble__actions {
  display: none;
  margin-left: auto;
  gap: 4px;
}

.message-bubble--user:hover .message-bubble__actions {
  display: inline-flex;
}

.message-bubble__header {
  display: flex;
  align-items: center;
  gap: 4px;
}

.message-bubble__action-btn {
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px 4px;
  font-size: 14px;
  color: #9ca3af;
  border-radius: 4px;
  line-height: 1;
}

.message-bubble__action-btn:hover {
  background: #e5e7eb;
  color: #374151;
}

.message-bubble__action-btn--delete:hover {
  background: #fee2e2;
  color: #dc2626;
}

/* Edit mode */
.message-bubble__edit-mode {
  margin-top: 4px;
}

.message-bubble__edit-textarea {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid #c7d2fe;
  border-radius: 6px;
  font-size: 14px;
  font-family: inherit;
  line-height: 1.5;
  resize: vertical;
  background: #fff;
  color: #1f2937;
  box-sizing: border-box;
}

.message-bubble__edit-textarea:focus {
  outline: none;
  border-color: #818cf8;
  box-shadow: 0 0 0 2px rgba(129, 140, 248, 0.2);
}

.message-bubble__edit-actions {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}

.message-bubble__edit-btn {
  padding: 4px 12px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  background: #fff;
  color: #374151;
}

.message-bubble__edit-btn:hover {
  background: #f3f4f6;
}

.message-bubble__edit-btn--save {
  background: #4f46e5;
  color: #fff;
  border-color: #4f46e5;
}

.message-bubble__edit-btn--save:hover {
  background: #4338ca;
}

/* Delete confirmation */
.message-bubble__confirm-delete {
  margin-top: 4px;
  padding: 8px 10px;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 6px;
  font-size: 13px;
  color: #991b1b;
}

.message-bubble__confirm-actions {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}

.message-bubble__confirm-btn {
  padding: 4px 12px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  background: #fff;
  color: #374151;
}

.message-bubble__confirm-btn:hover {
  background: #f3f4f6;
}

.message-bubble__confirm-btn--delete {
  background: #dc2626;
  color: #fff;
  border-color: #dc2626;
}

.message-bubble__confirm-btn--delete:hover {
  background: #b91c1c;
}
```

**Step 5: Verify TypeScript compilation**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent/frontend && npx tsc --noEmit`

Expected: No errors

**Step 6: Commit**

```bash
git add frontend/src/components/MessageBubble.tsx frontend/src/components/MessageBubble.css frontend/src/components/AgentPanel.tsx
git commit -m "feat: add edit/delete hover actions and inline UI to MessageBubble"
```

---

### Task 6: Manual integration test

**Files:** None (testing only)

**Step 1: Start the backend**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent && make dev-backend`

Expected: FastAPI server starts on http://localhost:8000

**Step 2: Start the frontend**

In a separate terminal:
Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent && make dev-frontend`

Expected: Vite dev server starts on http://localhost:5173

**Step 3: Test edit flow**

1. Open http://localhost:5173
2. Switch to Agent Mode
3. Upload a CSV or load sample data
4. Send a message: "Show me the first 5 rows"
5. Wait for agent response
6. Hover over the user message — verify pencil and trash icons appear
7. Click pencil icon — verify textarea appears with message text
8. Change to "Show me the last 10 rows" and click "Save & Resend"
9. Verify: old response is removed, new response streams in

**Step 4: Test delete flow**

1. Send a second message after the first
2. Hover over the first user message
3. Click trash icon — verify confirmation dialog appears
4. Click "Delete" — verify the message and all messages after it are removed
5. Verify the chat shows the state before that message

**Step 5: Test edge cases**

1. Verify hover icons do NOT appear while streaming
2. Verify pressing Escape cancels edit mode
3. Verify pressing Cancel on delete confirmation dismisses it
4. Delete the only remaining message — verify chat resets to empty state

**Step 6: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address integration test issues for edit/delete"
```
