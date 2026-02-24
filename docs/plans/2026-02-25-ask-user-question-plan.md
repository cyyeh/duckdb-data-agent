# Ask User Question Tool — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable the agent to ask users interactive questions mid-conversation with clickable options (single-select, multi-select, free-text), pausing the agent until the user responds.

**Architecture:** Add `ask_user_question` as an MCP tool. When called, the tool handler stores the question in a `PendingQuestionStore` and awaits an `asyncio.Event`. The SSE generator emits a `user_question` event to the frontend, which renders inline buttons. When the user responds (POST `/api/chat/respond`), the event is set, the tool handler returns the answer, and the agent continues.

**Tech Stack:** Python (FastAPI, asyncio, MCP), TypeScript (React, SSE)

---

### Task 1: PendingQuestionStore backend module

**Files:**
- Create: `backend/app/pending_questions.py`
- Test: `backend/tests/test_pending_questions.py`

**Step 1: Write the failing tests**

Create `backend/tests/test_pending_questions.py`:

```python
import asyncio
import pytest
from app.pending_questions import PendingQuestionStore


@pytest.fixture
def store():
    return PendingQuestionStore()


def test_create_returns_question_id(store):
    """create() returns a unique question_id string."""
    qid = store.create("session-1", {"question": "Pick one", "options": []})
    assert isinstance(qid, str)
    assert len(qid) > 0


def test_create_stores_question_data(store):
    """create() stores the question data retrievable by get_pending()."""
    qid = store.create("session-1", {"question": "Pick one", "options": [{"label": "A"}]})
    pending = store.get_pending("session-1")
    assert pending is not None
    assert pending["question_id"] == qid
    assert pending["data"]["question"] == "Pick one"


def test_respond_sets_answer(store):
    """respond() stores the answer for the given question."""
    qid = store.create("session-1", {"question": "Pick one", "options": []})
    store.respond("session-1", qid, {"answers": ["A"]})
    # The event should be set (wait returns immediately)


@pytest.mark.asyncio
async def test_wait_returns_answer_after_respond(store):
    """wait() returns the answer once respond() is called."""
    qid = store.create("session-1", {"question": "Pick one", "options": []})

    async def respond_later():
        await asyncio.sleep(0.05)
        store.respond("session-1", qid, {"answers": ["B"]})

    asyncio.create_task(respond_later())
    answer = await store.wait("session-1", qid, timeout=5.0)
    assert answer == {"answers": ["B"]}


@pytest.mark.asyncio
async def test_wait_timeout_returns_none(store):
    """wait() returns None when timeout expires without a response."""
    qid = store.create("session-1", {"question": "Pick", "options": []})
    answer = await store.wait("session-1", qid, timeout=0.1)
    assert answer is None


def test_cleanup_removes_session(store):
    """cleanup() removes all pending questions for a session."""
    store.create("session-1", {"question": "Pick", "options": []})
    store.cleanup("session-1")
    assert store.get_pending("session-1") is None


def test_respond_wrong_question_id_is_noop(store):
    """respond() with wrong question_id does nothing."""
    store.create("session-1", {"question": "Pick", "options": []})
    store.respond("session-1", "wrong-id", {"answers": ["A"]})
    # No error, just ignored


def test_multiple_sessions_independent(store):
    """Questions from different sessions don't interfere."""
    qid1 = store.create("session-1", {"question": "Q1", "options": []})
    qid2 = store.create("session-2", {"question": "Q2", "options": []})
    assert qid1 != qid2
    assert store.get_pending("session-1")["data"]["question"] == "Q1"
    assert store.get_pending("session-2")["data"]["question"] == "Q2"
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent && python -m pytest backend/tests/test_pending_questions.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.pending_questions'`

**Step 3: Implement PendingQuestionStore**

Create `backend/app/pending_questions.py`:

```python
import asyncio
import uuid


class PendingQuestionStore:
    """Thread-safe store for pending user questions.

    Coordinates between the SSE stream generator (which detects the tool call)
    and the /api/chat/respond endpoint (which receives the user's answer).
    """

    def __init__(self):
        self._pending: dict[str, dict] = {}  # keyed by session_id

    def create(self, session_id: str, question_data: dict) -> str:
        """Store a pending question and return a unique question_id."""
        question_id = str(uuid.uuid4())
        self._pending[session_id] = {
            "question_id": question_id,
            "data": question_data,
            "event": asyncio.Event(),
            "answer": None,
        }
        return question_id

    def get_pending(self, session_id: str) -> dict | None:
        """Get the pending question for a session, or None."""
        entry = self._pending.get(session_id)
        if entry is None:
            return None
        return {
            "question_id": entry["question_id"],
            "data": entry["data"],
        }

    def respond(self, session_id: str, question_id: str, answer: dict) -> None:
        """Set the answer for a pending question and signal the waiter."""
        entry = self._pending.get(session_id)
        if entry is None or entry["question_id"] != question_id:
            return
        entry["answer"] = answer
        entry["event"].set()

    async def wait(self, session_id: str, question_id: str, timeout: float = 300.0) -> dict | None:
        """Wait for the user's answer. Returns None on timeout."""
        entry = self._pending.get(session_id)
        if entry is None or entry["question_id"] != question_id:
            return None
        try:
            await asyncio.wait_for(entry["event"].wait(), timeout=timeout)
            return entry["answer"]
        except asyncio.TimeoutError:
            return None
        finally:
            # Clean up after wait completes (success or timeout)
            if session_id in self._pending and self._pending[session_id]["question_id"] == question_id:
                del self._pending[session_id]

    def cleanup(self, session_id: str) -> None:
        """Remove pending question for a session."""
        self._pending.pop(session_id, None)


# Singleton instance shared between MCP tool handler and /api/chat/respond endpoint
pending_question_store = PendingQuestionStore()
```

**Step 4: Run tests to verify they pass**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent && python -m pytest backend/tests/test_pending_questions.py -v`
Expected: All 8 tests PASS

**Step 5: Commit**

```bash
git add backend/app/pending_questions.py backend/tests/test_pending_questions.py
git commit -m "feat: add PendingQuestionStore for ask-user-question tool"
```

---

### Task 2: Add ask_user_question MCP tool (subprocess path)

**Files:**
- Modify: `backend/app/tools.py:17-51` (add tool to `create_duckdb_server`)
- Modify: `backend/app/agent.py:530` (add to `allowed_tools`)
- Test: `backend/tests/test_tools.py` (add tests)

**Step 1: Write the failing tests**

Add to `backend/tests/test_tools.py`:

```python
@pytest.mark.asyncio
async def test_ask_user_question_tool_exists(db):
    """Server registers ask_user_question tool."""
    server = create_duckdb_server(db, "test-session")
    tool_names = [t.name for t in server._tools]
    assert "ask_user_question" in tool_names


@pytest.mark.asyncio
async def test_ask_user_question_stores_and_waits(db):
    """ask_user_question stores question and returns answer after respond()."""
    from app.pending_questions import pending_question_store
    import asyncio

    server = create_duckdb_server(db, "test-session-aq")
    ask_tool = next(t for t in server._tools if t.name == "ask_user_question")

    async def respond_later():
        await asyncio.sleep(0.05)
        pending = pending_question_store.get_pending("test-session-aq")
        assert pending is not None
        pending_question_store.respond("test-session-aq", pending["question_id"], {"answers": ["Bar chart"]})

    asyncio.create_task(respond_later())
    result = await ask_tool.handler({
        "question": "Which chart?",
        "options": [{"label": "Bar chart"}, {"label": "Line chart"}],
        "multi_select": False,
    })
    content_text = result["content"][0]["text"]
    parsed = json.loads(content_text)
    assert parsed["answers"] == ["Bar chart"]


@pytest.mark.asyncio
async def test_ask_user_question_timeout(db):
    """ask_user_question returns timeout result when no response."""
    server = create_duckdb_server(db, "test-session-timeout")
    ask_tool = next(t for t in server._tools if t.name == "ask_user_question")

    result = await ask_tool.handler({
        "question": "Which chart?",
        "options": [{"label": "A"}],
        "timeout": 0.1,
    })
    content_text = result["content"][0]["text"]
    parsed = json.loads(content_text)
    assert parsed["timeout"] is True
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent && python -m pytest backend/tests/test_tools.py -v`
Expected: FAIL — `create_duckdb_server()` takes wrong args / tool not found

**Step 3: Update `create_duckdb_server` to accept `session_id` and add `ask_user_question` tool**

Modify `backend/app/tools.py`:

```python
import json
from typing import Any
from claude_agent_sdk import tool, create_sdk_mcp_server
from app.database import Database
from app.pending_questions import pending_question_store

MAX_RESULT_ROWS = 100


class DuckDBServer(dict):
    """Wraps McpSdkServerConfig (a TypedDict/dict) and exposes _tools for testing."""

    def __init__(self, config: dict, tools: list) -> None:
        super().__init__(config)
        self._tools = tools


def create_duckdb_server(db: Database, session_id: str = "default") -> "DuckDBServer":
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
            result = await db.execute_query_async(sql)
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

    @tool(
        "ask_user_question",
        "Ask the user a clarifying question with selectable options. Use this when the user's "
        "request is ambiguous or when you need to choose between multiple valid approaches. "
        "The tool will pause and wait for the user to select an option before continuing. "
        "Always provide clear, concise options. The user can also type a free-text response.",
        {
            "question": str,
            "options": list,
            "multi_select": bool,
        },
    )
    async def ask_user_question(args: dict[str, Any]) -> dict[str, Any]:
        question_data = {
            "question": args["question"],
            "options": args.get("options", []),
            "multi_select": args.get("multi_select", False),
        }
        timeout = args.get("timeout", 300.0)  # Internal override for testing
        question_id = pending_question_store.create(session_id, question_data)
        answer = await pending_question_store.wait(session_id, question_id, timeout=timeout)
        if answer is None:
            result = {"timeout": True, "message": "User did not respond within the time limit."}
        else:
            result = answer
        return {"content": [{"type": "text", "text": json.dumps(result)}]}

    tools = [execute_sql, ask_user_question]
    config = create_sdk_mcp_server(
        name="duckdb",
        version="1.0.0",
        tools=tools,
    )
    return DuckDBServer(config, tools)
```

**Step 4: Update existing tests for new `session_id` parameter**

In `backend/tests/test_tools.py`, update existing tests to pass `session_id`:
- Change `create_duckdb_server(db)` to `create_duckdb_server(db, "test-session")` in `test_execute_sql_returns_results`, `test_execute_sql_error`, and `test_server_has_only_execute_sql_tool`.
- Update `test_server_has_only_execute_sql_tool` assertion to include `"ask_user_question"`.

**Step 5: Update `agent.py` to pass `session_id` and add tool to allowed list**

In `backend/app/agent.py`:

1. At line 517, change:
   ```python
   duckdb_server = create_duckdb_server(db)
   ```
   to:
   ```python
   stable_session = backend_session_id or "default"
   duckdb_server = create_duckdb_server(db, session_id=stable_session)
   ```

2. At line 530, change:
   ```python
   allowed_tools=["Task", "mcp__duckdb__execute_sql"],
   ```
   to:
   ```python
   allowed_tools=["Task", "mcp__duckdb__execute_sql", "mcp__duckdb__ask_user_question"],
   ```

**Step 6: Run tests to verify they pass**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent && python -m pytest backend/tests/test_tools.py -v`
Expected: All tests PASS

**Step 7: Commit**

```bash
git add backend/app/tools.py backend/app/agent.py backend/tests/test_tools.py
git commit -m "feat: add ask_user_question MCP tool to subprocess path"
```

---

### Task 3: Add /api/chat/respond endpoint

**Files:**
- Modify: `backend/app/routes/chat.py:1-71` (add endpoint)
- Test: `backend/tests/test_respond_endpoint.py` (new test file)

**Step 1: Write the failing test**

Create `backend/tests/test_respond_endpoint.py`:

```python
import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient
from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


def test_respond_endpoint_resolves_pending_question(client):
    """POST /api/chat/respond sets the answer on the pending question store."""
    from app.pending_questions import pending_question_store

    qid = pending_question_store.create("test-respond-session", {
        "question": "Pick one",
        "options": [{"label": "A"}],
    })

    response = client.post(
        "/api/chat/respond",
        json={"question_id": qid, "answers": ["A"]},
        headers={"X-Session-ID": "test-respond-session"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_respond_endpoint_missing_session_id(client):
    """POST /api/chat/respond without X-Session-ID returns 422."""
    response = client.post(
        "/api/chat/respond",
        json={"question_id": "abc", "answers": ["A"]},
    )
    assert response.status_code == 422


def test_respond_endpoint_unknown_question(client):
    """POST /api/chat/respond with unknown question_id returns 404."""
    response = client.post(
        "/api/chat/respond",
        json={"question_id": "nonexistent", "answers": ["A"]},
        headers={"X-Session-ID": "no-such-session"},
    )
    assert response.status_code == 404
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent && python -m pytest backend/tests/test_respond_endpoint.py -v`
Expected: FAIL — 404 because endpoint doesn't exist

**Step 3: Add the endpoint**

Add to `backend/app/routes/chat.py`:

```python
from app.pending_questions import pending_question_store
```

Add new Pydantic model after `ChatEditRequest`:

```python
class QuestionResponseRequest(BaseModel):
    question_id: str
    answers: list[str] = []
    free_text: str | None = None
```

Add new endpoint after the `chat_edit` function:

```python
@router.post("/chat/respond")
async def respond_to_question(
    request: QuestionResponseRequest,
    x_session_id: str = Header(...),
):
    """Respond to a pending user question from the agent."""
    pending = pending_question_store.get_pending(x_session_id)
    if pending is None or pending["question_id"] != request.question_id:
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=404, content={"error": "No pending question found"})

    answer = {"answers": request.answers}
    if request.free_text:
        answer["free_text"] = request.free_text
    pending_question_store.respond(x_session_id, request.question_id, answer)
    return {"status": "ok"}
```

**Step 4: Run tests to verify they pass**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent && python -m pytest backend/tests/test_respond_endpoint.py -v`
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add backend/app/routes/chat.py backend/tests/test_respond_endpoint.py
git commit -m "feat: add /api/chat/respond endpoint for user question answers"
```

---

### Task 4: Emit user_question SSE event in subprocess path

**Files:**
- Modify: `backend/app/agent.py:620-655` (detect ask_user_question tool call, emit SSE event, add keepalives)

**Step 1: Understand the change**

In `stream_chat()`, after detecting `ToolUseBlock` for `ask_user_question` at ~line 622-639, we need to:
1. Emit a `user_question` SSE event with the question data and question_id
2. Send keepalive comments while the tool is waiting for the user

The tricky part: the SDK calls the MCP tool handler internally. The SSE generator only observes messages via `client.receive_response()`. After the `AssistantMessage` with the `ToolUseBlock` is yielded, the SDK internally invokes the MCP tool handler. The next message from `client.receive_response()` will be the `UserMessage` with the tool result (which won't come until the user responds).

So between emitting the `user_question` event and receiving the next message, we need to keep the SSE connection alive. We can do this by periodically yielding keepalive comments.

However, `async for msg in client.receive_response()` blocks waiting for the next message. We need to change this to use `asyncio.wait_for` with a timeout loop so we can send keepalives.

**Step 2: Modify the stream loop in `stream_chat()`**

In `backend/app/agent.py`, replace the main stream loop. After the `AssistantMessage` handling for `ToolUseBlock`:

Add a helper at the top of the `stream_chat` function (after `actual_session_id = session_id`):

```python
waiting_for_user = False
```

In the `AssistantMessage` handling, after emitting the `tool_call` event for any tool, add detection for `ask_user_question`:

```python
# Detect ask_user_question tool
if "ask_user_question" in tool_name:
    # Retrieve the pending question from the store
    from app.pending_questions import pending_question_store
    pending = pending_question_store.get_pending(stable_session)
    if pending:
        yield f"event: user_question\ndata: {json.dumps({'question_id': pending['question_id'], **pending['data']})}\n\n"
        waiting_for_user = True
```

Replace the `async for msg in client.receive_response():` loop with a pattern that sends keepalives:

```python
response_iter = client.receive_response().__aiter__()
while True:
    try:
        if waiting_for_user:
            # Send keepalives while waiting for user response
            try:
                msg = await asyncio.wait_for(response_iter.__anext__(), timeout=5.0)
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
                continue
        else:
            msg = await response_iter.__anext__()
    except StopAsyncIteration:
        break

    waiting_for_user = False  # Reset once we get a message
    # ... rest of the message handling stays the same
```

Add `import asyncio` at the top of the file (it's already imported for the container path but check).

**Step 3: Run existing tests to verify nothing is broken**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent && python -m pytest backend/tests/ -v`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add backend/app/agent.py
git commit -m "feat: emit user_question SSE event and keepalives in subprocess path"
```

---

### Task 5: Emit user_question SSE event in container path

**Files:**
- Modify: `backend/app/mcp_sse.py:24-67` (add ask_user_question tool to MCP bridge)
- Modify: `backend/app/agent.py:370-396` (detect tool in container path SSE, emit event)

**Step 1: Add ask_user_question to the MCP bridge**

In `backend/app/mcp_sse.py`, modify `_create_mcp_server()`:

1. Add import at top:
   ```python
   from app.pending_questions import pending_question_store
   ```

2. In `list_tools()`, add after the `execute_sql` tool:
   ```python
   types.Tool(
       name="ask_user_question",
       description=(
           "Ask the user a clarifying question with selectable options. "
           "Pauses until the user responds."
       ),
       inputSchema={
           "type": "object",
           "properties": {
               "question": {"type": "string"},
               "options": {
                   "type": "array",
                   "items": {
                       "type": "object",
                       "properties": {
                           "label": {"type": "string"},
                           "description": {"type": "string"},
                       },
                       "required": ["label"],
                   },
               },
               "multi_select": {"type": "boolean", "default": False},
           },
           "required": ["question", "options"],
       },
   ),
   ```

3. In `call_tool()`, add an `elif` branch for `ask_user_question`. Note: `handle_sse` passes the `session_id` query param. We need to thread it through. Modify `_create_mcp_server` to accept `session_id`:

   ```python
   def _create_mcp_server(db: Database, session_id: str) -> MCPServer:
   ```

   Then add the branch:
   ```python
   elif name == "ask_user_question":
       question_data = {
           "question": arguments.get("question", ""),
           "options": arguments.get("options", []),
           "multi_select": arguments.get("multi_select", False),
       }
       question_id = pending_question_store.create(session_id, question_data)
       answer = await pending_question_store.wait(session_id, question_id, timeout=300.0)
       if answer is None:
           result = {"timeout": True, "message": "User did not respond within the time limit."}
       else:
           result = answer
       return [types.TextContent(type="text", text=json.dumps(result))]
   ```

4. Update `handle_sse` to pass `session_id` to `_create_mcp_server`:
   ```python
   server = _create_mcp_server(db, session_id)
   ```

**Step 2: Detect ask_user_question in container SSE stream**

In `backend/app/agent.py`, in `_stream_chat_container()`, in the `elif msg_type == "assistant"` block (around line 371-395), after emitting `tool_call` for tool_use blocks, add detection:

```python
if tool_name == "Task":
    # existing subagent handling...
elif "ask_user_question" in tool_name:
    from app.pending_questions import pending_question_store
    # The MCP bridge will create the pending question when the container calls it.
    # We need to poll for it since the bridge runs in a different async context.
    import asyncio
    for _ in range(50):  # wait up to 5 seconds for the question to appear
        pending = pending_question_store.get_pending(stable_session)
        if pending:
            yield f"event: user_question\ndata: {json.dumps({'question_id': pending['question_id'], **pending['data']})}\n\n"
            break
        await asyncio.sleep(0.1)
```

Also add keepalives in the container path. The container path already reads lines from `response.aiter_lines()`. Between lines, if waiting for user, we should yield keepalives. However, `aiter_lines()` doesn't support timeouts directly. We can use `asyncio.wait_for`:

After the `async for line in response.aiter_lines():` loop, change to:

```python
line_iter = response.aiter_lines().__aiter__()
while True:
    try:
        if waiting_for_user:
            try:
                line = await asyncio.wait_for(line_iter.__anext__(), timeout=5.0)
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
                continue
        else:
            line = await line_iter.__anext__()
    except StopAsyncIteration:
        break
    # Reset waiting flag on any message from container
    if line.startswith("data: "):
        waiting_for_user = False
    # ... rest of line handling
```

Add `waiting_for_user = False` at the start of the container function.

**Step 3: Run existing tests**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent && python -m pytest backend/tests/ -v`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add backend/app/mcp_sse.py backend/app/agent.py
git commit -m "feat: add ask_user_question to container/MCP bridge path"
```

---

### Task 6: Update system prompt

**Files:**
- Modify: `backend/app/agent.py:53-75` (`build_system_prompt()`)

**Step 1: Add instruction about ask_user_question to the system prompt**

In `build_system_prompt()`, add after the identity section (line ~65):

```python
prompt += """
Clarification:
- When the user's request is ambiguous or could be interpreted in multiple ways, use the ask_user_question tool to ask for clarification before proceeding.
- Provide 2-4 clear, concise options for the user to choose from.
- Each option should have a short label and optional description.
- Only ask when genuinely needed — don't over-ask for trivial decisions.
"""
```

**Step 2: Run existing tests**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent && python -m pytest backend/tests/ -v`
Expected: All tests PASS

**Step 3: Commit**

```bash
git add backend/app/agent.py
git commit -m "feat: add ask_user_question guidance to system prompt"
```

---

### Task 7: Frontend types and SSE event handling

**Files:**
- Modify: `frontend/src/types.ts:38-48` (add `user_question` segment type and types)
- Modify: `frontend/src/agent/agentService.ts:1-14,174-237` (add callback and event handler)

**Step 1: Add types to `frontend/src/types.ts`**

Add new interfaces after `ToolCallResult` (after line 36):

```typescript
export interface UserQuestionOption {
  label: string;
  description?: string;
}

export interface UserQuestionData {
  questionId: string;
  question: string;
  options: UserQuestionOption[];
  multiSelect: boolean;
}
```

Update `ContentSegment` (line 38-48):
- Add `'user_question'` to the type union
- Add `questionData?: UserQuestionData`
- Add `userAnswer?: string[]`

```typescript
export interface ContentSegment {
  type: 'thinking' | 'tool' | 'answer' | 'subagent_start' | 'subagent_end' | 'user_question';
  text?: string;
  toolResult?: ToolCallResult;
  subagentId?: string;
  subagentName?: string;
  chart_spec?: {
    data: unknown[];
    layout?: Record<string, unknown>;
  };
  questionData?: UserQuestionData;
  userAnswer?: string[];
}
```

**Step 2: Add SSE event handling in `agentService.ts`**

Add to `AgentCallbacks` interface (after `onSubagentEnd`):

```typescript
onUserQuestion?: (data: UserQuestionData) => void;
```

Add case to `handleSSEEvent` switch (after `subagent_end` case):

```typescript
case 'user_question':
  callbacks.onUserQuestion?.({
    questionId: data.question_id as string,
    question: data.question as string,
    options: (data.options as UserQuestionOption[]) ?? [],
    multiSelect: (data.multi_select as boolean) ?? false,
  });
  break;
```

Add import for new types at the top:

```typescript
import type { ToolCallResult, UserQuestionData, UserQuestionOption } from '../types';
```

**Step 3: Commit**

```bash
git add frontend/src/types.ts frontend/src/agent/agentService.ts
git commit -m "feat: add UserQuestion types and SSE event handling in frontend"
```

---

### Task 8: AgentContext — handle user_question callback and respondToQuestion

**Files:**
- Modify: `frontend/src/hooks/useAgent.ts:1-24` (add `respondToQuestion` to context)
- Modify: `frontend/src/contexts/AgentContext.tsx:1-497` (add callback and respond function)

**Step 1: Update `useAgent.ts` context interface**

Add `respondToQuestion` to `AgentContextValue`:

```typescript
interface AgentContextValue {
  messages: ChatMessage[];
  isStreaming: boolean;
  sendMessage: (text: string) => void;
  editMessage: (messageIndex: number, newContent: string) => void;
  deleteMessage: (messageIndex: number) => void;
  clearMessages: () => void;
  respondToQuestion: (questionId: string, answers: string[], freeText?: string) => void;
}
```

Add `respondToQuestion: () => {}` to the default context value.

**Step 2: Add `onUserQuestion` callback and `respondToQuestion` in `AgentContext.tsx`**

In the `sendMessage` callbacks object, add `onUserQuestion`:

```typescript
onUserQuestion: (data) => {
  if (flushTimerRef.current) {
    clearTimeout(flushTimerRef.current);
    flushTimerRef.current = null;
  }
  flushText();
  if (currentTextRef.current.trim()) {
    segmentsRef.current.push({ type: 'thinking', text: currentTextRef.current });
    currentTextRef.current = '';
  }
  segmentsRef.current.push({
    type: 'user_question',
    questionData: data,
  });
  setMessages((prev) =>
    prev.map((m) =>
      m.id === assistantId
        ? { ...m, segments: [...segmentsRef.current] }
        : m
    )
  );
},
```

Add the same `onUserQuestion` callback to the `editMessage` callbacks too.

Add `respondToQuestion` function:

```typescript
const respondToQuestion = useCallback(
  async (questionId: string, answers: string[], freeText?: string) => {
    // Update the segment to show the user's answer
    const segIdx = segmentsRef.current.findIndex(
      (s) => s.type === 'user_question' && s.questionData?.questionId === questionId
    );
    if (segIdx !== -1) {
      segmentsRef.current[segIdx] = {
        ...segmentsRef.current[segIdx],
        userAnswer: answers,
      };
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantIdRef.current
            ? { ...m, segments: [...segmentsRef.current] }
            : m
        )
      );
    }

    // POST to backend
    try {
      await fetch('/api/chat/respond', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(userSessionId ? { 'X-Session-ID': userSessionId } : {}),
        },
        body: JSON.stringify({
          question_id: questionId,
          answers,
          free_text: freeText || null,
        }),
      });
    } catch (e) {
      console.error('Failed to respond to question:', e);
    }
  },
  [userSessionId]
);
```

Add `respondToQuestion` to the Provider value.

**Step 3: Commit**

```bash
git add frontend/src/hooks/useAgent.ts frontend/src/contexts/AgentContext.tsx
git commit -m "feat: add respondToQuestion to AgentContext"
```

---

### Task 9: UserQuestion component

**Files:**
- Create: `frontend/src/components/UserQuestion.tsx`
- Create: `frontend/src/components/UserQuestion.css`

**Step 1: Create the UserQuestion component**

Create `frontend/src/components/UserQuestion.tsx`:

```tsx
import { useState } from 'react';
import { useTranslation } from '../hooks/useTranslation';
import { useAgent } from '../hooks/useAgent';
import type { UserQuestionData } from '../types';
import './UserQuestion.css';

export function UserQuestion({
  questionData,
  userAnswer,
}: {
  questionData: UserQuestionData;
  userAnswer?: string[];
}) {
  const { t } = useTranslation();
  const { respondToQuestion } = useAgent();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [freeText, setFreeText] = useState('');
  const [showFreeText, setShowFreeText] = useState(false);
  const isAnswered = !!userAnswer;

  const handleOptionClick = (label: string) => {
    if (isAnswered) return;
    if (questionData.multiSelect) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(label)) next.delete(label);
        else next.add(label);
        return next;
      });
    } else {
      // Single-select: submit immediately
      respondToQuestion(questionData.questionId, [label]);
    }
  };

  const handleSubmitMulti = () => {
    if (isAnswered) return;
    const answers = [...selected];
    if (showFreeText && freeText.trim()) {
      respondToQuestion(questionData.questionId, answers, freeText.trim());
    } else {
      respondToQuestion(questionData.questionId, answers);
    }
  };

  const handleSubmitFreeText = () => {
    if (isAnswered || !freeText.trim()) return;
    respondToQuestion(questionData.questionId, [], freeText.trim());
  };

  if (isAnswered) {
    return (
      <div className="user-question user-question--answered">
        <div className="user-question__label">{t('questionAnswered')}</div>
        <div className="user-question__question">{questionData.question}</div>
        <div className="user-question__selected-answers">
          {userAnswer.map((a, i) => (
            <span key={i} className="user-question__selected-chip">{a}</span>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="user-question">
      <div className="user-question__label">{t('questionFromAgent')}</div>
      <div className="user-question__question">{questionData.question}</div>
      <div className="user-question__options">
        {questionData.options.map((opt, i) => (
          <button
            key={i}
            className={`user-question__option ${selected.has(opt.label) ? 'user-question__option--selected' : ''}`}
            onClick={() => handleOptionClick(opt.label)}
          >
            {questionData.multiSelect && (
              <span className="user-question__checkbox">
                {selected.has(opt.label) ? '\u2611' : '\u2610'}
              </span>
            )}
            <span className="user-question__option-label">{opt.label}</span>
            {opt.description && (
              <span className="user-question__option-desc">{opt.description}</span>
            )}
          </button>
        ))}
      </div>
      <div className="user-question__free-text-toggle">
        <button
          className="user-question__other-btn"
          onClick={() => setShowFreeText(!showFreeText)}
        >
          {showFreeText ? t('hideOther') : t('other')}
        </button>
      </div>
      {showFreeText && (
        <div className="user-question__free-text">
          <input
            type="text"
            className="user-question__free-text-input"
            placeholder={t('typeYourAnswer')}
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleSubmitFreeText();
              }
            }}
          />
          <button
            className="user-question__submit-btn"
            onClick={handleSubmitFreeText}
            disabled={!freeText.trim()}
          >
            {t('submit')}
          </button>
        </div>
      )}
      {questionData.multiSelect && selected.size > 0 && (
        <button className="user-question__submit-btn" onClick={handleSubmitMulti}>
          {t('submit')} ({selected.size})
        </button>
      )}
    </div>
  );
}
```

**Step 2: Create the CSS**

Create `frontend/src/components/UserQuestion.css`:

```css
.user-question {
  padding: 10px 12px;
  margin: 4px 0;
  border: 1px solid var(--color-accent-primary-border);
  border-radius: 8px;
  background: var(--color-bg-secondary);
}

.user-question--answered {
  opacity: 0.8;
  border-color: var(--color-border-dark);
}

.user-question__label {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--color-accent-primary-light);
  margin-bottom: 6px;
}

.user-question--answered .user-question__label {
  color: var(--color-text-disabled);
}

.user-question__question {
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text-secondary);
  margin-bottom: 10px;
}

.user-question__options {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.user-question__option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--color-border-dark);
  border-radius: 6px;
  background: var(--color-bg-primary);
  cursor: pointer;
  text-align: left;
  font-size: 13px;
  color: var(--color-text-secondary);
  transition: border-color 0.15s, background 0.15s;
}

.user-question__option:hover {
  border-color: var(--color-accent-primary-border);
  background: var(--color-accent-primary-bg);
}

.user-question__option--selected {
  border-color: var(--color-accent-primary-light);
  background: var(--color-accent-primary-bg);
}

.user-question__checkbox {
  flex-shrink: 0;
  font-size: 16px;
}

.user-question__option-label {
  font-weight: 500;
}

.user-question__option-desc {
  display: block;
  font-size: 12px;
  color: var(--color-text-disabled);
  margin-top: 2px;
}

.user-question__free-text-toggle {
  margin-top: 8px;
}

.user-question__other-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12px;
  color: var(--color-accent-primary-light);
  padding: 2px 0;
  text-decoration: underline;
}

.user-question__free-text {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}

.user-question__free-text-input {
  flex: 1;
  padding: 6px 10px;
  border: 1px solid var(--color-border-dark);
  border-radius: 6px;
  font-size: 13px;
  background: var(--color-bg-primary);
  color: var(--color-text-secondary);
}

.user-question__free-text-input:focus {
  outline: none;
  border-color: var(--color-accent-primary-light);
}

.user-question__submit-btn {
  padding: 6px 14px;
  border: none;
  border-radius: 6px;
  background: var(--color-accent-primary-hover);
  color: var(--color-bg-primary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
}

.user-question__submit-btn:hover {
  background: var(--color-accent-primary-active);
}

.user-question__submit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.user-question__selected-answers {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}

.user-question__selected-chip {
  padding: 3px 10px;
  border-radius: 12px;
  background: var(--color-success-bg);
  color: var(--color-success-text);
  font-size: 12px;
  font-weight: 500;
}
```

**Step 3: Commit**

```bash
git add frontend/src/components/UserQuestion.tsx frontend/src/components/UserQuestion.css
git commit -m "feat: add UserQuestion inline component"
```

---

### Task 10: Integrate UserQuestion into MessageBubble

**Files:**
- Modify: `frontend/src/components/MessageBubble.tsx:1-9,46-49,80-93` (import and render UserQuestion in thinking block)

**Step 1: Add import**

Add to imports at top of `MessageBubble.tsx`:

```typescript
import { UserQuestion } from './UserQuestion';
```

**Step 2: Render user_question segments in ThinkingBlock**

In the `ThinkingBlock` component, inside the `thinkingSegments.map()` callback (around line 66-94), add a new condition after the `subagent_start` handler:

```tsx
if (seg.type === 'user_question' && seg.questionData) {
  return (
    <div key={i} className="message-bubble__tool-segment">
      <UserQuestion
        questionData={seg.questionData}
        userAnswer={seg.userAnswer}
      />
    </div>
  );
}
```

Also update the `hasContent` check (line 50-52) to include `user_question`:

```typescript
const hasContent = thinkingSegments.some(
  (s) => (s.type === 'thinking' && s.text?.trim()) || (s.type === 'tool' && s.toolResult) || s.type === 'subagent_start' || s.type === 'user_question'
) || streamingRemainder?.trim();
```

**Step 3: Commit**

```bash
git add frontend/src/components/MessageBubble.tsx
git commit -m "feat: render UserQuestion in MessageBubble thinking block"
```

---

### Task 11: Add i18n keys

**Files:**
- Modify: `frontend/src/i18n/en.json`
- Modify: `frontend/src/i18n/zh-TW.json`

**Step 1: Add English keys**

Add to `en.json` (before the closing `}`):

```json
"questionFromAgent": "Question",
"questionAnswered": "Answered",
"other": "Other...",
"hideOther": "Hide other",
"typeYourAnswer": "Type your answer...",
"submit": "Submit"
```

**Step 2: Add Chinese keys**

Add to `zh-TW.json` (before the closing `}`):

```json
"questionFromAgent": "問題",
"questionAnswered": "已回答",
"other": "其他...",
"hideOther": "隱藏其他",
"typeYourAnswer": "輸入您的答案...",
"submit": "提交"
```

**Step 3: Commit**

```bash
git add frontend/src/i18n/en.json frontend/src/i18n/zh-TW.json
git commit -m "feat: add i18n keys for UserQuestion component"
```

---

### Task 12: Manual integration test

**Step 1: Start the backend and frontend**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent && make dev` (or however the dev server is started)

**Step 2: Upload a CSV file**

Upload any CSV file to create a table.

**Step 3: Ask an ambiguous question**

Send a message like: "Show me a chart of this data"

The agent should call `ask_user_question` to ask what chart type to use. The question should appear inline in the thinking block with clickable options. Click an option and verify the agent continues with your selection.

**Step 4: Test multi-select**

Send: "Which columns should I analyze? Ask me first."

Verify multi-select checkboxes appear and the Submit button works.

**Step 5: Test free-text**

Click "Other..." and type a custom answer. Verify it's sent correctly.

**Step 6: Test timeout behavior**

(Optional) Temporarily reduce the timeout to 10 seconds in the tool handler and verify the agent proceeds with a timeout message.

---

### Summary of all files changed

**New files:**
- `backend/app/pending_questions.py`
- `backend/tests/test_pending_questions.py`
- `backend/tests/test_respond_endpoint.py`
- `frontend/src/components/UserQuestion.tsx`
- `frontend/src/components/UserQuestion.css`

**Modified files:**
- `backend/app/tools.py` — added `ask_user_question` tool, `session_id` param
- `backend/app/agent.py` — SSE events, keepalives, system prompt, `session_id` pass-through
- `backend/app/routes/chat.py` — `/api/chat/respond` endpoint
- `backend/app/mcp_sse.py` — `ask_user_question` in MCP bridge
- `frontend/src/types.ts` — new types, updated `ContentSegment`
- `frontend/src/agent/agentService.ts` — `user_question` event handler
- `frontend/src/contexts/AgentContext.tsx` — `onUserQuestion` callback, `respondToQuestion`
- `frontend/src/hooks/useAgent.ts` — exposed `respondToQuestion`
- `frontend/src/components/MessageBubble.tsx` — render `UserQuestion` in segments
- `frontend/src/i18n/en.json` — new keys
- `frontend/src/i18n/zh-TW.json` — new keys
