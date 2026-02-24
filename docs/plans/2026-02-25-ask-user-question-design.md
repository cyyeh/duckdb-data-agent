# Ask User Question Tool — Design

## Problem

The agent currently has no way to ask users clarifying questions mid-conversation. When a request is ambiguous (e.g., "show me a chart" without specifying chart type), the agent must guess. This leads to suboptimal results and wasted compute.

## Solution

Add an `ask_user_question` MCP tool that the agent can call to present interactive questions to the user inline in the chat. The tool pauses the agent, renders clickable options in the frontend, waits for the user's response, and feeds it back to the agent.

## Requirements

- Agent-initiated: the agent calls the tool when it needs clarification
- Inline UI: options render as clickable buttons inside the assistant's message bubble
- Full interaction types: single-select, multi-select, and free-text "Other" input
- Both execution paths: subprocess and container/sidecar
- Timeout: 5-minute limit with graceful fallback

## Architecture

### Data Flow

```
Agent calls ask_user_question tool
    ↓
SDK yields AssistantMessage with ToolUseBlock
    ↓
SSE generator emits "user_question" event → Frontend renders inline buttons
    ↓
MCP tool handler awaits asyncio.Event (with SSE keepalives)
    ↓
User clicks option → Frontend POSTs to /api/chat/respond
    ↓
Backend resolves asyncio.Event with user's answer
    ↓
MCP tool handler returns answer as tool result
    ↓
SDK continues → agent receives answer and proceeds
```

### Shared State

A `PendingQuestionStore` (dict keyed by backend session ID) holds the question data and an `asyncio.Event`. Both the SSE stream generator and the `/api/chat/respond` endpoint access it.

### SSE Keepalives

While waiting for user input, the SSE generator sends `: keepalive\n\n` comments every 5 seconds to prevent connection timeout.

## Backend Design

### New module: `backend/app/pending_questions.py`

`PendingQuestionStore` class:
- `create(session_id, question_data) -> question_id` — stores question + creates `asyncio.Event`
- `respond(session_id, question_id, answer)` — sets the answer and triggers the event
- `wait(session_id, question_id, timeout=300) -> answer` — awaits the event
- `cleanup(session_id)` — removes pending questions for a session

Singleton instance: `pending_question_store`.

### MCP Tool: `ask_user_question`

Added to the DuckDB MCP server in `tools.py`. Input schema:

```json
{
  "question": "Which chart type would you prefer?",
  "options": [
    {"label": "Bar chart", "description": "Best for comparing categories"},
    {"label": "Line chart", "description": "Best for trends over time"}
  ],
  "multi_select": false
}
```

The tool handler:
1. Stores the question in `PendingQuestionStore`
2. Awaits the `asyncio.Event` (up to 5 min timeout)
3. Returns the user's answer as a JSON string

### New API Endpoint

```
POST /api/chat/respond
Headers: X-Session-ID: <backend_session_id>
Body: {
  "question_id": "...",
  "answers": ["Bar chart"],
  "free_text": null
}
```

Calls `pending_question_store.respond()` which sets the event.

### SSE Events

New event types emitted by the SSE generator:
- `user_question` — question data + question_id sent to frontend
- Agent.py detects `ToolUseBlock` with name containing `ask_user_question` and emits this event

### System Prompt

Add instruction that the agent has `ask_user_question` available for clarification.

## Frontend Design

### New Types (`types.ts`)

```typescript
interface UserQuestionOption {
  label: string;
  description?: string;
}

interface UserQuestionData {
  questionId: string;
  question: string;
  options: UserQuestionOption[];
  multiSelect: boolean;
}
```

`ContentSegment` gets new type `'user_question'` with fields:
- `questionData?: UserQuestionData`
- `userAnswer?: string[]`

### SSE Handling (`agentService.ts`)

New callback: `onUserQuestion?: (data: UserQuestionData) => void`
Handles `user_question` SSE event type.

### Agent Context (`AgentContext.tsx`)

- `onUserQuestion` callback creates a `ContentSegment` of type `user_question`
- New `respondToQuestion(questionId, answers)` function that:
  1. POSTs to `/api/chat/respond`
  2. Updates the segment with `userAnswer`

### New Component: `UserQuestion.tsx`

Renders inline in message bubble:
- Question text
- Single-select: radio-button-style clickable cards
- Multi-select: checkbox-style cards + "Submit" button
- "Other" free-text input always available at bottom
- After answering: collapses to show selected answer(s) with checkmark
- Disabled state after answering (prevents double-submit)

### MessageBubble Changes

In the thinking block segment rendering, handle `type === 'user_question'` → render `<UserQuestion>`.

## Container/Sidecar Path

- The MCP SSE bridge (`mcp_sse.py`) exposes `ask_user_question` alongside `execute_sql`
- The tool handler in the bridge stores the question in `PendingQuestionStore` and waits
- The SSE generator in `_stream_chat_container` detects the tool call and emits `user_question`
- The `/api/chat/respond` endpoint resolves it identically
- No sidecar code changes needed — the tool is available via MCP automatically

## Error Handling

- **Timeout (5 min):** Tool returns `{"timeout": true, "message": "User did not respond within the time limit."}`
- **User disconnects:** Abort signal triggers cleanup. Tool returns disconnect error.
- **Multiple questions:** One pending question per session at a time. Each has a unique `question_id`.
- **SSE keepalives:** Every 5 seconds while waiting.

## Testing

- Unit tests for `PendingQuestionStore` (create, respond, wait, timeout, cleanup)
- Unit tests for the MCP tool handler
- Frontend: manual testing of all interaction types (single-select, multi-select, free-text)

## Files to Modify

### New Files
- `backend/app/pending_questions.py`
- `frontend/src/components/UserQuestion.tsx`
- `frontend/src/components/UserQuestion.css`

### Modified Files
- `backend/app/tools.py` — add `ask_user_question` tool
- `backend/app/agent.py` — detect tool call, emit SSE event, add keepalives while waiting
- `backend/app/routes/chat.py` — add `/api/chat/respond` endpoint
- `backend/app/mcp_sse.py` — add tool to MCP bridge for container path
- `frontend/src/types.ts` — new types
- `frontend/src/agent/agentService.ts` — handle `user_question` SSE event
- `frontend/src/contexts/AgentContext.tsx` — new callback + `respondToQuestion`
- `frontend/src/components/MessageBubble.tsx` — render `UserQuestion` in segments
- `frontend/src/hooks/useAgent.ts` — expose `respondToQuestion`
