# Langfuse Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add optional Langfuse observability tracing to the agent backend and a "Langfuse Traces" button to the agent mode UI.

**Architecture:** Backend uses Langfuse Python SDK v3 with OpenTelemetry auto-instrumentation via `langsmith[claude-agent-sdk]`. The langsmith integration automatically captures LLM generations, tool calls, and token usage. Langfuse receives traces through its OTel receiver. Frontend fetches Langfuse status from an API endpoint and renders a button that opens the Langfuse dashboard. Tracing is conditional — zero overhead when Langfuse is not configured.

**Tech Stack:** Langfuse Python SDK v3, langsmith (OTel), FastAPI, React 18, TypeScript

**Design Doc:** `docs/plans/2026-02-20-langfuse-integration-design.md`

---

### Task 1: Add Langfuse dependency and configuration

**Files:**
- Modify: `backend/pyproject.toml:9-16` (add langfuse to dependencies)
- Modify: `backend/app/config.py:1-7` (add Langfuse env vars)
- Modify: `backend/.env.example:1-2` (add Langfuse vars)

**Step 1: Add langfuse to pyproject.toml**

In `backend/pyproject.toml`, add `langfuse` to `[tool.poetry.dependencies]`:

```toml
[tool.poetry.dependencies]
python = "^3.12"
fastapi = "^0.129.0"
uvicorn = {extras = ["standard"], version = "^0.41.0"}
duckdb = "^1.4.4"
python-dotenv = "^1.2.1"
python-multipart = "^0.0.22"
claude-agent-sdk = "^0.1.38"
langfuse = "^3.0.0"
```

**Step 2: Add Langfuse config vars**

In `backend/app/config.py`, add after the existing ANTHROPIC vars:

```python
import os
from dotenv import load_dotenv

load_dotenv()

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-opus-4-6")

LANGFUSE_PUBLIC_KEY = os.getenv("LANGFUSE_PUBLIC_KEY", "")
LANGFUSE_SECRET_KEY = os.getenv("LANGFUSE_SECRET_KEY", "")
LANGFUSE_BASE_URL = os.getenv("LANGFUSE_BASE_URL", "https://cloud.langfuse.com")
LANGFUSE_ENABLED = bool(LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY)
```

**Step 3: Update .env.example**

In `backend/.env.example`, add Langfuse vars:

```
ANTHROPIC_API_KEY=your-api-key-here
ANTHROPIC_MODEL=claude-sonnet-4-6
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

**Step 4: Install dependencies**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent/backend && poetry install`
Expected: langfuse package installed successfully

**Step 5: Verify config imports work**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent/backend && poetry run python -c "from app.config import LANGFUSE_ENABLED; print('LANGFUSE_ENABLED:', LANGFUSE_ENABLED)"`
Expected: `LANGFUSE_ENABLED: False` (since no keys are set in .env)

**Step 6: Commit**

```bash
git add backend/pyproject.toml backend/poetry.lock backend/app/config.py backend/.env.example
git commit -m "feat: add langfuse dependency and configuration"
```

---

### Task 2: Create tracing module

**Files:**
- Create: `backend/app/tracing.py`

**Step 1: Create the tracing module**

Create `backend/app/tracing.py`:

```python
import logging

from app.config import (
    LANGFUSE_ENABLED,
    LANGFUSE_PUBLIC_KEY,
    LANGFUSE_SECRET_KEY,
    LANGFUSE_BASE_URL,
)

logger = logging.getLogger(__name__)

_langfuse_client = None


def _init_langfuse():
    """Initialize Langfuse client if configured."""
    global _langfuse_client
    if not LANGFUSE_ENABLED:
        logger.info("Langfuse not configured, tracing disabled")
        return

    try:
        from langfuse import Langfuse

        _langfuse_client = Langfuse(
            public_key=LANGFUSE_PUBLIC_KEY,
            secret_key=LANGFUSE_SECRET_KEY,
            base_url=LANGFUSE_BASE_URL,
        )
        if _langfuse_client.auth_check():
            logger.info("Langfuse connected successfully")
        else:
            logger.warning("Langfuse auth check failed, tracing disabled")
            _langfuse_client = None
    except Exception as e:
        logger.warning("Failed to initialize Langfuse: %s", e)
        _langfuse_client = None


def get_langfuse_client():
    """Return the Langfuse client or None if not configured."""
    return _langfuse_client


def get_langfuse_dashboard_url() -> str | None:
    """Return the Langfuse dashboard base URL or None."""
    if _langfuse_client is None:
        return None
    return LANGFUSE_BASE_URL


# Initialize on module import
_init_langfuse()
```

**Step 2: Verify module loads without Langfuse keys**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent/backend && poetry run python -c "from app.tracing import get_langfuse_client; print('Client:', get_langfuse_client())"`
Expected: `Langfuse not configured, tracing disabled` log message and `Client: None`

**Step 3: Commit**

```bash
git add backend/app/tracing.py
git commit -m "feat: add langfuse tracing module with conditional init"
```

---

### Task 3: Create Langfuse status API endpoint

**Files:**
- Create: `backend/app/routes/langfuse.py`
- Modify: `backend/app/main.py:8,20-22` (register new router)

**Step 1: Create the langfuse route**

Create `backend/app/routes/langfuse.py`:

```python
from fastapi import APIRouter

from app.tracing import get_langfuse_client, get_langfuse_dashboard_url

router = APIRouter(prefix="/api", tags=["langfuse"])


@router.get("/langfuse/status")
async def langfuse_status():
    return {
        "enabled": get_langfuse_client() is not None,
        "dashboardUrl": get_langfuse_dashboard_url(),
    }
```

**Step 2: Register the router in main.py**

In `backend/app/main.py`, add the import and include the router:

```python
from app.routes import tables, query, chat, langfuse

# ... existing code ...

app.include_router(langfuse.router)
```

**Step 3: Test the endpoint**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent/backend && poetry run uvicorn app.main:app --port 8000 &`
Then: `curl http://localhost:8000/api/langfuse/status`
Expected: `{"enabled":false,"dashboardUrl":null}`
Cleanup: kill the background uvicorn process

**Step 4: Commit**

```bash
git add backend/app/routes/langfuse.py backend/app/main.py
git commit -m "feat: add GET /api/langfuse/status endpoint"
```

---

### Task 4: Add Langfuse tracing to agent.py

**Files:**
- Modify: `backend/app/agent.py:1-197` (add tracing instrumentation)

This is the core task. The approach wraps the existing `stream_chat()` with Langfuse tracing without changing the SSE protocol.

**Step 1: Add tracing imports and helper**

At the top of `backend/app/agent.py`, add the tracing import:

```python
from app.tracing import get_langfuse_client
```

**Step 2: Add tracing context to stream_chat**

Modify `stream_chat()` to create a Langfuse trace at the start and add spans for tool executions. The key changes:

1. At the start of `stream_chat()`, create a trace if Langfuse is available
2. For each `ToolUseBlock` with SQL, create a tool span
3. Capture LLM text output in a generation span
4. End the trace when the stream completes or errors

The modified `stream_chat()` function:

```python
async def stream_chat(message: str, session_id: str | None = None) -> AsyncIterator[str]:
    """Stream agent chat responses as SSE events."""
    duckdb_server = create_duckdb_server()

    logger.info("Using model: %s", ANTHROPIC_MODEL)
    options = ClaudeAgentOptions(
        model=ANTHROPIC_MODEL,
        system_prompt=build_system_prompt(),
        mcp_servers={"duckdb": duckdb_server},
        allowed_tools=["mcp__duckdb__execute_sql"],
        permission_mode="bypassPermissions",
        max_turns=20,
        include_partial_messages=True,
    )

    client = ClaudeSDKClient(options=options)
    actual_session_id = session_id

    # Langfuse tracing (conditional)
    langfuse = get_langfuse_client()
    trace = None
    current_generation = None
    llm_turn = 0
    accumulated_thinking = ""
    accumulated_answer = ""

    if langfuse:
        trace = langfuse.trace(
            name="agent-chat",
            session_id=session_id or "default",
            input={"message": message[:500]},
            metadata={"model": ANTHROPIC_MODEL},
        )

    try:
        await client.connect()
        await client.query(message, session_id=session_id or "default")

        current_text = ""
        has_tool_calls = False
        thinking_sent = False
        has_thinking = False
        sql_result_ids: set[str] = set()
        tool_names: dict[str, str] = {}

        async for raw_data in client._query.receive_messages():
            try:
                msg = parse_message(raw_data)
            except MessageParseError as e:
                logger.debug("Skipping unrecognized message: %s", e)
                continue

            if isinstance(msg, StreamEvent):
                event = msg.event
                if not actual_session_id:
                    actual_session_id = msg.session_id

                event_type = event.get("type", "")

                if event_type == "content_block_delta":
                    delta = event.get("delta", {})
                    delta_type = delta.get("type", "")
                    if delta_type == "thinking_delta":
                        text = delta.get("thinking", "")
                        if text:
                            current_text += text
                            accumulated_thinking += text
                            yield f"event: thinking\ndata: {json.dumps({'text': text})}\n\n"
                    elif delta_type == "text_delta":
                        text = delta.get("text", "")
                        current_text += text
                        accumulated_answer += text
                        event_name = "thinking" if not has_tool_calls else "answer"
                        yield f"event: {event_name}\ndata: {json.dumps({'text': text})}\n\n"

                elif event_type == "content_block_start":
                    block = event.get("content_block", {})
                    block_type = block.get("type")
                    if block_type == "thinking":
                        has_thinking = True
                        # Start a new generation span for this LLM turn
                        if trace:
                            llm_turn += 1
                            current_generation = trace.generation(
                                name=f"llm-turn-{llm_turn}",
                                model=ANTHROPIC_MODEL,
                                input={"message": message[:500]} if llm_turn == 1 else {"continued": True},
                            )
                    elif block_type == "text":
                        if has_thinking:
                            yield f"event: thinking_done\ndata: {json.dumps({})}\n\n"
                        elif trace and not current_generation:
                            # Text block without thinking — start generation
                            llm_turn += 1
                            current_generation = trace.generation(
                                name=f"llm-turn-{llm_turn}",
                                model=ANTHROPIC_MODEL,
                                input={"message": message[:500]} if llm_turn == 1 else {"continued": True},
                            )
                    elif block_type == "tool_use":
                        if current_text.strip() and not thinking_sent:
                            thinking_sent = True
                        has_tool_calls = True
                        # End current generation before tool use
                        if current_generation:
                            current_generation.end(
                                output={"thinking": accumulated_thinking[:1000], "text": accumulated_answer[:1000]},
                            )
                            current_generation = None
                            accumulated_thinking = ""
                            accumulated_answer = ""

            elif isinstance(msg, AssistantMessage):
                if not actual_session_id:
                    actual_session_id = "default"

                for block in msg.content:
                    if isinstance(block, ToolUseBlock):
                        has_tool_calls = True
                        tool_name = getattr(block, "name", "") or ""
                        tool_names[block.id] = tool_name
                        sql = block.input.get("sql", "")
                        command = block.input.get("command", "")

                        # Emit tool_call for ALL tool types
                        tool_call_data: dict = {"id": block.id, "name": tool_name}
                        if sql:
                            tool_call_data["sql"] = sql
                        if command:
                            tool_call_data["command"] = command
                        if not sql and not command:
                            tool_call_data["input"] = block.input
                        yield f"event: tool_call\ndata: {json.dumps(tool_call_data, default=str)}\n\n"

                        # For SQL tools, execute query for structured results
                        if sql:
                            sql_result_ids.add(block.id)

                            # Create tool span in trace
                            tool_span = trace.span(
                                name=f"tool-{tool_name}",
                                input={"sql": sql},
                            ) if trace else None

                            try:
                                result = db.execute_query(sql)
                                truncated = result["rows"][:100]
                                yield f"event: tool_result\ndata: {json.dumps({'id': block.id, 'name': tool_name, 'sql': sql, 'columns': result['columns'], 'rows': truncated, 'rowCount': result['rowCount']}, default=str)}\n\n"
                                if tool_span:
                                    tool_span.end(output={"rowCount": result["rowCount"], "columns": result["columns"]})
                            except Exception as e:
                                yield f"event: tool_result\ndata: {json.dumps({'id': block.id, 'name': tool_name, 'sql': sql, 'error': str(e)})}\n\n"
                                if tool_span:
                                    tool_span.end(output={"error": str(e)}, level="ERROR")

            elif isinstance(msg, UserMessage):
                # Capture tool results from the SDK for non-SQL tools
                content = msg.content
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, ToolResultBlock):
                            if block.tool_use_id in sql_result_ids:
                                continue
                            output = _extract_tool_result_text(block.content)
                            name = tool_names.get(block.tool_use_id, "")
                            result_data: dict = {
                                "id": block.tool_use_id,
                                "name": name,
                                "output": output,
                            }
                            if block.is_error:
                                result_data["error"] = output
                            yield f"event: tool_result\ndata: {json.dumps(result_data, default=str)}\n\n"

            elif isinstance(msg, ResultMessage):
                actual_session_id = msg.session_id
                if msg.is_error and msg.result:
                    yield f"event: error\ndata: {json.dumps({'message': msg.result})}\n\n"
                yield f"event: done\ndata: {json.dumps({'session_id': actual_session_id})}\n\n"
                break

    except Exception as e:
        yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"
    finally:
        # End any open generation span
        if current_generation:
            current_generation.end(
                output={"thinking": accumulated_thinking[:1000], "text": accumulated_answer[:1000]},
            )
        # Finalize trace
        if trace:
            trace.update(output={"session_id": actual_session_id})
        if langfuse:
            langfuse.flush()
        try:
            await client.disconnect()
        except Exception:
            pass
```

**Step 3: Verify backend still starts without Langfuse configured**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent/backend && poetry run python -c "from app.agent import stream_chat; print('Agent module loads OK')"`
Expected: `Agent module loads OK` (tracing disabled log message may appear)

**Step 4: Commit**

```bash
git add backend/app/agent.py
git commit -m "feat: add langfuse tracing to agent chat streaming"
```

---

### Task 5: Add Langfuse status fetching to frontend App.tsx

**Files:**
- Modify: `frontend/src/App.tsx:1-213` (add Langfuse status state, fetch on load, pass to AgentPanel)

**Step 1: Add Langfuse status state and fetch**

In `frontend/src/App.tsx`, make these changes:

1. Add a `LangfuseStatus` type and state to the `App` component
2. Fetch `/api/langfuse/status` during the initial load (alongside health check)
3. Pass `langfuseStatus` to `AppContent` and then to `AgentPanel`

In `App` component, add state:

```typescript
interface LangfuseStatus {
  enabled: boolean;
  dashboardUrl: string | null;
}
```

In the `App` component, add:

```typescript
const [langfuseStatus, setLangfuseStatus] = useState<LangfuseStatus>({ enabled: false, dashboardUrl: null });
```

In the existing `useEffect` fetch block, after `await refreshTables()`, add:

```typescript
try {
  const lfRes = await fetch('/api/langfuse/status');
  if (lfRes.ok) {
    setLangfuseStatus(await lfRes.json());
  }
} catch {
  // Langfuse status fetch is non-critical
}
```

Pass `langfuseStatus` through `AppContent` to `AgentPanel`:

```tsx
<AgentPanel langfuseStatus={langfuseStatus} />
```

Update `AppContent` props to accept and pass through `langfuseStatus`.

**Step 2: Verify TypeScript compiles**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent/frontend && npx tsc --noEmit`
Expected: no errors (AgentPanel will need updating in next task, so may have type error — that's expected)

**Step 3: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat: fetch langfuse status on app load and pass to AgentPanel"
```

---

### Task 6: Add Langfuse Traces button to AgentPanel

**Files:**
- Modify: `frontend/src/components/AgentPanel.tsx:1-39` (add button)
- Modify: `frontend/src/components/AgentPanel.css:1-52` (add button styles)

**Step 1: Update AgentPanel component**

Modify `frontend/src/components/AgentPanel.tsx` to accept `langfuseStatus` prop and render the button:

```tsx
import { useEffect, useRef } from 'react';
import { useAgent } from '../AgentContext';
import { ChatInput } from './ChatInput';
import { MessageBubble } from './MessageBubble';
import './AgentPanel.css';

interface LangfuseStatus {
  enabled: boolean;
  dashboardUrl: string | null;
}

interface AgentPanelProps {
  langfuseStatus: LangfuseStatus;
}

export function AgentPanel({ langfuseStatus }: AgentPanelProps) {
  const { messages, clearMessages } = useAgent();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="agent-panel">
      <div className="agent-panel__header">
        <span className="agent-panel__title">Agent Mode</span>
        <div className="agent-panel__actions">
          <button
            className={`agent-panel__langfuse ${!langfuseStatus.enabled ? 'agent-panel__langfuse--disabled' : ''}`}
            disabled={!langfuseStatus.enabled}
            title={langfuseStatus.enabled ? 'Open Langfuse dashboard' : 'Langfuse not configured'}
            onClick={() => {
              if (langfuseStatus.dashboardUrl) {
                window.open(langfuseStatus.dashboardUrl, '_blank', 'noopener,noreferrer');
              }
            }}
          >
            Langfuse Traces
          </button>
          {messages.length > 0 && (
            <button className="agent-panel__clear" onClick={clearMessages}>
              Clear
            </button>
          )}
        </div>
      </div>
      <div className="agent-panel__messages">
        {messages.length === 0 && (
          <div className="agent-panel__empty">
            Ask a question about your data, and the agent will write and run SQL queries to find the answer.
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        <div ref={bottomRef} />
      </div>
      <ChatInput />
    </div>
  );
}
```

**Step 2: Add CSS styles for the button**

Add to `frontend/src/components/AgentPanel.css`:

```css
.agent-panel__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.agent-panel__langfuse {
  padding: 4px 10px;
  font-size: 12px;
  background: none;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  color: #6b7280;
  cursor: pointer;
  text-decoration: none;
}

.agent-panel__langfuse:hover:not(:disabled) {
  background: #f3f4f6;
  color: #374151;
}

.agent-panel__langfuse--disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
```

**Step 3: Verify TypeScript compiles and dev server runs**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent/frontend && npx tsc --noEmit`
Expected: no type errors

**Step 4: Commit**

```bash
git add frontend/src/components/AgentPanel.tsx frontend/src/components/AgentPanel.css
git commit -m "feat: add Langfuse Traces button to agent panel header"
```

---

### Task 7: Manual integration test

**Files:** None (testing only)

**Step 1: Start the dev server**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent && make dev`

**Step 2: Verify without Langfuse configured**

- Open http://localhost:5173 in browser
- Switch to Agent Mode
- Verify "Langfuse Traces" button is visible but grayed out/disabled
- Verify hovering shows "Langfuse not configured" tooltip
- Verify agent chat still works normally (send a message, get response)
- Verify `GET /api/langfuse/status` returns `{"enabled":false,"dashboardUrl":null}`

**Step 3: Verify with Langfuse configured (if keys available)**

Add real Langfuse keys to `backend/.env`:
```
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

- Restart backend
- Verify "Langfuse Traces" button is now enabled
- Click it — should open Langfuse dashboard in new tab
- Send an agent message — verify traces appear in Langfuse dashboard
- Check trace has: agent-chat trace → llm-turn generations → tool spans

**Step 4: Stop dev server and commit any fixes if needed**
