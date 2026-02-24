# Subagent-Based SQL & Chart Generation — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace MCP tool-based `execute_sql`/`generate_chart` with two specialized subagents (sql-analyst, chart-builder) using the claude-agent-sdk `AgentDefinition` API.

**Architecture:** Orchestrator agent delegates to subagents via the built-in `Task` tool. SQL subagent handles data queries; chart subagent handles Plotly visualizations. Both have `execute_sql` MCP tool access. Models configurable per subagent.

**Tech Stack:** Python 3.12, FastAPI, claude-agent-sdk (AgentDefinition), React 18, TypeScript, react-plotly.js

---

### Task 1: Add subagent model config vars

**Files:**
- Modify: `backend/app/config.py:14-15` (after ANTHROPIC_MODEL line)

**Step 1: Write the failing test**

Create `backend/tests/test_subagent_config.py`:

```python
from app.config import SQL_SUBAGENT_MODEL, CHART_SUBAGENT_MODEL


def test_subagent_model_defaults():
    """Subagent model configs should have sensible defaults."""
    assert SQL_SUBAGENT_MODEL in ("haiku", "sonnet", "opus", "inherit")
    assert CHART_SUBAGENT_MODEL in ("haiku", "sonnet", "opus", "inherit")
```

**Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_subagent_config.py -v`
Expected: FAIL with `ImportError: cannot import name 'SQL_SUBAGENT_MODEL'`

**Step 3: Write minimal implementation**

Add to `backend/app/config.py` after line 15 (`ANTHROPIC_MODEL = ...`):

```python
SQL_SUBAGENT_MODEL = os.getenv("SQL_SUBAGENT_MODEL", "haiku")
CHART_SUBAGENT_MODEL = os.getenv("CHART_SUBAGENT_MODEL", "haiku")
```

**Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_subagent_config.py -v`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/app/config.py backend/tests/test_subagent_config.py
git commit -m "feat: add SQL_SUBAGENT_MODEL and CHART_SUBAGENT_MODEL config"
```

---

### Task 2: Add `build_subagent_definitions()` function

**Files:**
- Modify: `backend/app/agent.py` (add new function + new import)
- Test: `backend/tests/test_subagent_definitions.py`

**Step 1: Write the failing test**

Create `backend/tests/test_subagent_definitions.py`:

```python
from unittest.mock import MagicMock
from app.database import Database
from claude_agent_sdk import AgentDefinition


def _make_db(tables=None):
    db = MagicMock(spec=Database)
    db.list_tables.return_value = tables or []
    return db


def test_build_subagent_definitions_returns_two_agents():
    """Should return sql-analyst and chart-builder AgentDefinitions."""
    from app.agent import build_subagent_definitions

    db = _make_db()
    agents = build_subagent_definitions(db)

    assert "sql-analyst" in agents
    assert "chart-builder" in agents
    assert isinstance(agents["sql-analyst"], AgentDefinition)
    assert isinstance(agents["chart-builder"], AgentDefinition)


def test_sql_analyst_has_execute_sql_tool():
    from app.agent import build_subagent_definitions

    db = _make_db()
    agents = build_subagent_definitions(db)

    assert agents["sql-analyst"].tools == ["mcp__duckdb__execute_sql"]


def test_chart_builder_has_execute_sql_tool():
    from app.agent import build_subagent_definitions

    db = _make_db()
    agents = build_subagent_definitions(db)

    assert agents["chart-builder"].tools == ["mcp__duckdb__execute_sql"]


def test_subagent_prompts_include_table_schemas():
    from app.agent import build_subagent_definitions

    db = _make_db(tables=[{
        "name": "sales",
        "rowCount": 100,
        "columns": [{"name": "id", "type": "INTEGER"}, {"name": "amount", "type": "DOUBLE"}],
    }])
    agents = build_subagent_definitions(db)

    assert '"sales"' in agents["sql-analyst"].prompt
    assert '"id"' in agents["sql-analyst"].prompt
    assert '"sales"' in agents["chart-builder"].prompt


def test_subagent_models_use_config():
    from app.agent import build_subagent_definitions

    db = _make_db()
    agents = build_subagent_definitions(db)

    # Default is "haiku" from config
    assert agents["sql-analyst"].model is not None
    assert agents["chart-builder"].model is not None
```

**Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_subagent_definitions.py -v`
Expected: FAIL with `ImportError: cannot import name 'build_subagent_definitions'`

**Step 3: Write minimal implementation**

Add to `backend/app/agent.py`:

1. Add import at top (after existing imports, around line 23):
```python
from claude_agent_sdk import AgentDefinition
from app.config import SQL_SUBAGENT_MODEL, CHART_SUBAGENT_MODEL
```

2. Add new function after `build_system_prompt()` (after line 85):

```python
def _build_table_schemas(db: Database) -> str:
    """Build table schema text for subagent prompts."""
    tables = db.list_tables()
    if not tables:
        return "\nNo tables are currently loaded. Ask the user to upload a CSV file first."
    text = "\nCurrently loaded tables:\n"
    for table in tables:
        text += f'\nTable: "{table["name"]}" ({table["rowCount"]} rows)\nColumns:\n'
        for col in table["columns"]:
            text += f'  - "{col["name"]}" ({col["type"]})\n'
    return text


def build_subagent_definitions(db: Database) -> dict[str, AgentDefinition]:
    """Build AgentDefinition dict for sql-analyst and chart-builder subagents."""
    table_schemas = _build_table_schemas(db)

    sql_agent = AgentDefinition(
        description=(
            "Use this agent for any data question that requires SQL queries — "
            "exploring data, aggregations, filtering, joins, etc."
        ),
        prompt=(
            "You are a DuckDB SQL expert. Your job is to write and execute SQL queries "
            "to answer data questions.\n\n"
            "Guidelines:\n"
            "- Write clear, efficient DuckDB SQL\n"
            "- Start with small queries (use LIMIT) when exploring\n"
            "- If a query fails, analyze the error and fix it\n"
            "- Return results with a brief explanation\n"
            "- Use double quotes for table and column names that might conflict with reserved words\n"
            + table_schemas
        ),
        tools=["mcp__duckdb__execute_sql"],
        model=SQL_SUBAGENT_MODEL,
    )

    chart_agent = AgentDefinition(
        description="Use this agent when the user wants a chart, graph, or visualization.",
        prompt=(
            "You are a data visualization expert using Plotly. Your job is to create "
            "effective visualizations from data.\n\n"
            "Your final output MUST include a JSON code block with this structure:\n"
            '```json\n'
            '{\n'
            '  "chart_spec": {\n'
            '    "data": [{ "type": "bar", "x": [...], "y": [...] }],\n'
            '    "layout": { "title": "..." }\n'
            '  }\n'
            '}\n'
            '```\n\n'
            "Guidelines:\n"
            "- Choose the right chart type for the data (bar, scatter, line, pie, histogram, box, heatmap)\n"
            "- Use execute_sql to fetch exactly the data needed for the chart\n"
            "- For multi-series data, group by a color column and create separate traces\n"
            '- For pie charts, use "labels" and "values" instead of "x" and "y"\n'
            "- Always include a descriptive title\n"
            + table_schemas
        ),
        tools=["mcp__duckdb__execute_sql"],
        model=CHART_SUBAGENT_MODEL,
    )

    return {"sql-analyst": sql_agent, "chart-builder": chart_agent}
```

**Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_subagent_definitions.py -v`
Expected: PASS (all 5 tests)

**Step 5: Commit**

```bash
git add backend/app/agent.py backend/tests/test_subagent_definitions.py
git commit -m "feat: add build_subagent_definitions() for sql-analyst and chart-builder"
```

---

### Task 3: Simplify orchestrator system prompt

**Files:**
- Modify: `backend/app/agent.py:50-85` (`build_system_prompt` function)
- Modify: `backend/tests/test_agent_chart.py` (update test)

**Step 1: Write the failing test**

Update `backend/tests/test_agent_chart.py` to check the new simplified prompt:

```python
from app.agent import build_system_prompt
from unittest.mock import MagicMock
from app.database import Database


def test_build_system_prompt_delegates_to_subagents():
    """System prompt should instruct orchestrator to use subagents, not tools directly."""
    db = MagicMock(spec=Database)
    db.list_tables.return_value = []
    prompt = build_system_prompt(db)
    assert "sql-analyst" in prompt
    assert "chart-builder" in prompt
    # Should NOT mention execute_sql or generate_chart tools directly
    assert "execute_sql" not in prompt
    assert "generate_chart" not in prompt
```

**Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_agent_chart.py -v`
Expected: FAIL — current prompt contains `execute_sql` and `generate_chart`

**Step 3: Write minimal implementation**

Replace `build_system_prompt()` in `backend/app/agent.py` (lines 50-85):

```python
def build_system_prompt(db: Database) -> str:
    tables = db.list_tables()
    prompt = """You are a helpful data analyst assistant working with a DuckDB database.

- Use the sql-analyst agent for any data question that requires SQL queries
- Use the chart-builder agent for any visualization, chart, or graph request
- Explain findings in plain language after getting results

Identity:
- You are an AI assistant. If asked whether you are an AI or a human, always confirm that you are an AI.
- Do not disclose the name, version, or provider of the underlying language model.
"""
    if not tables:
        prompt += "\nNo tables are currently loaded. Ask the user to upload a CSV file first."
    else:
        prompt += "\nCurrently loaded tables:\n"
        for table in tables:
            prompt += f'\nTable: "{table["name"]}" ({table["rowCount"]} rows)\nColumns:\n'
            for col in table["columns"]:
                prompt += f'  - "{col["name"]}" ({col["type"]})\n'

    return prompt
```

**Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_agent_chart.py -v`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/app/agent.py backend/tests/test_agent_chart.py
git commit -m "refactor: simplify orchestrator system prompt to delegate to subagents"
```

---

### Task 4: Remove `generate_chart` from tools.py

**Files:**
- Modify: `backend/app/tools.py` (remove generate_chart tool)
- Modify: `backend/tests/test_tools.py` (remove generate_chart tests)

**Step 1: Modify tools.py**

Replace `backend/app/tools.py` to remove `generate_chart` — keep only `execute_sql`:

```python
import json
from typing import Any
from claude_agent_sdk import tool, create_sdk_mcp_server
from app.database import Database

MAX_RESULT_ROWS = 100


class DuckDBServer(dict):
    """Wraps McpSdkServerConfig (a TypedDict/dict) and exposes _tools for testing."""

    def __init__(self, config: dict, tools: list) -> None:
        super().__init__(config)
        self._tools = tools


def create_duckdb_server(db: Database) -> "DuckDBServer":
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

    tools = [execute_sql]
    config = create_sdk_mcp_server(
        name="duckdb",
        version="1.0.0",
        tools=tools,
    )
    return DuckDBServer(config, tools)
```

**Step 2: Update tests**

Replace `backend/tests/test_tools.py` — remove generate_chart tests, keep execute_sql coverage:

```python
import json
import pytest
from unittest.mock import MagicMock, AsyncMock
from app.tools import create_duckdb_server
from app.database import Database


@pytest.fixture
def db():
    return MagicMock(spec=Database)


@pytest.mark.asyncio
async def test_execute_sql_returns_results(db):
    """execute_sql executes SQL and returns structured results."""
    db.execute_query_async = AsyncMock(return_value={
        "rows": [{"id": 1, "name": "Alice"}, {"id": 2, "name": "Bob"}],
        "columns": ["id", "name"],
        "rowCount": 2,
    })

    server = create_duckdb_server(db)
    execute_sql = next(t for t in server._tools if t.name == "execute_sql")

    result = await execute_sql.handler({"sql": "SELECT * FROM users"})
    content_text = result["content"][0]["text"]
    parsed = json.loads(content_text)

    assert parsed["status"] == "success"
    assert parsed["columns"] == ["id", "name"]
    assert len(parsed["rows"]) == 2


@pytest.mark.asyncio
async def test_execute_sql_error(db):
    """execute_sql returns error on query failure."""
    db.execute_query_async = AsyncMock(side_effect=Exception("syntax error"))

    server = create_duckdb_server(db)
    execute_sql = next(t for t in server._tools if t.name == "execute_sql")

    result = await execute_sql.handler({"sql": "INVALID SQL"})
    content_text = result["content"][0]["text"]
    parsed = json.loads(content_text)

    assert parsed["status"] == "error"
    assert "syntax error" in parsed["error"]


def test_server_has_only_execute_sql_tool(db):
    """Server should only register execute_sql tool (generate_chart removed)."""
    server = create_duckdb_server(db)
    tool_names = [t.name for t in server._tools]
    assert tool_names == ["execute_sql"]
```

**Step 3: Run tests**

Run: `cd backend && python -m pytest tests/test_tools.py -v`
Expected: PASS (all 3 tests)

**Step 4: Commit**

```bash
git add backend/app/tools.py backend/tests/test_tools.py
git commit -m "refactor: remove generate_chart tool, keep only execute_sql"
```

---

### Task 5: Remove `generate_chart` from MCP SSE server

**Files:**
- Modify: `backend/app/mcp_sse.py` (remove generate_chart tool and handler)
- Modify: `backend/tests/test_mcp_sse.py` (update tests)

**Step 1: Modify mcp_sse.py**

In `backend/app/mcp_sse.py`, update `_create_mcp_server()`:

1. In `list_tools()` (lines 29-65): Remove the `generate_chart` Tool entry, keep only `execute_sql`
2. In `call_tool()` (lines 67-154): Remove the `elif name == "generate_chart"` branch (lines 86-152)

The `list_tools()` should return only:
```python
@server.list_tools()
async def list_tools() -> list[types.Tool]:
    return [
        types.Tool(
            name="execute_sql",
            description=(
                "Execute a SQL query against the DuckDB database. "
                "Results are returned as JSON with columns, rows, and rowCount."
            ),
            inputSchema={
                "type": "object",
                "properties": {"sql": {"type": "string"}},
                "required": ["sql"],
            },
        ),
    ]
```

The `call_tool()` should only handle `execute_sql`:
```python
@server.call_tool()
async def call_tool(
    name: str, arguments: dict
) -> list[types.TextContent]:
    if name == "execute_sql":
        sql = arguments.get("sql", "")
        try:
            result = await db.execute_query_async(sql)
            truncated_rows = result["rows"][:MAX_RESULT_ROWS]
            result_json = {
                "status": "success",
                "columns": result["columns"],
                "rows": truncated_rows,
                "rowCount": result["rowCount"],
            }
            return [types.TextContent(type="text", text=json.dumps(result_json, default=str))]
        except Exception as e:
            error_json = {"status": "error", "error": str(e)}
            return [types.TextContent(type="text", text=json.dumps(error_json))]
    else:
        raise ValueError(f"Unknown tool: {name}")
```

**Step 2: Run existing MCP tests**

Run: `cd backend && python -m pytest tests/test_mcp_sse.py -v`
Expected: PASS (update any tests that reference generate_chart)

**Step 3: Commit**

```bash
git add backend/app/mcp_sse.py backend/tests/test_mcp_sse.py
git commit -m "refactor: remove generate_chart from MCP SSE server"
```

---

### Task 6: Wire subagents into `stream_chat()` ClaudeAgentOptions

**Files:**
- Modify: `backend/app/agent.py:410-414` (ClaudeAgentOptions in stream_chat)

**Step 1: Write the failing test**

Create `backend/tests/test_agent_subagent_options.py`:

```python
import pytest
from unittest.mock import MagicMock, AsyncMock, patch
from app.database import Database


@pytest.mark.asyncio
async def test_stream_chat_uses_subagents_and_task_tool():
    """stream_chat should configure ClaudeAgentOptions with subagents and Task tool."""
    db = MagicMock(spec=Database)
    db.list_tables.return_value = []

    captured_options = {}

    class FakeClient:
        def __init__(self, options=None):
            captured_options["options"] = options

        async def connect(self):
            pass

        async def query(self, msg, session_id=None):
            pass

        async def receive_response(self):
            from claude_agent_sdk.types import ResultMessage
            yield ResultMessage(
                type="result",
                subtype="success",
                session_id="test-session",
                is_error=False,
                result="",
                errors=[],
                duration_ms=100,
                duration_api_ms=80,
                num_turns=1,
                cost=None,
            )

        async def disconnect(self):
            pass

    with patch("app.agent.ClaudeSDKClient", FakeClient), \
         patch("app.agent.proxy_token_store") as mock_proxy:
        mock_proxy.create_token.return_value = "fake-token"
        mock_proxy.revoke_token = MagicMock()

        from app.agent import stream_chat
        events = []
        async for event in stream_chat("test", db=db):
            events.append(event)

    opts = captured_options["options"]
    assert "Task" in opts.allowed_tools
    assert opts.agents is not None
    assert "sql-analyst" in opts.agents
    assert "chart-builder" in opts.agents
```

**Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_agent_subagent_options.py -v`
Expected: FAIL — current code uses `allowed_tools=["mcp__duckdb__execute_sql", "mcp__duckdb__generate_chart"]` and no `agents`

**Step 3: Write minimal implementation**

In `backend/app/agent.py`, modify `stream_chat()` around lines 410-414:

Change:
```python
    options = ClaudeAgentOptions(
        model=ANTHROPIC_MODEL,
        system_prompt=build_system_prompt(db),
        mcp_servers={"duckdb": duckdb_server},
        allowed_tools=["mcp__duckdb__execute_sql", "mcp__duckdb__generate_chart"],
```

To:
```python
    options = ClaudeAgentOptions(
        model=ANTHROPIC_MODEL,
        system_prompt=build_system_prompt(db),
        mcp_servers={"duckdb": duckdb_server},
        allowed_tools=["Task", "mcp__duckdb__execute_sql"],
        agents=build_subagent_definitions(db),
```

Note: `mcp__duckdb__execute_sql` stays in `allowed_tools` so subagents can inherit it. `Task` enables subagent delegation.

**Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_agent_subagent_options.py -v`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/app/agent.py backend/tests/test_agent_subagent_options.py
git commit -m "feat: wire subagent definitions into stream_chat ClaudeAgentOptions"
```

---

### Task 7: Add `subagent_start`/`subagent_end` SSE event emission in `stream_chat()`

**Files:**
- Modify: `backend/app/agent.py` (SSE streaming logic in `stream_chat()`, around lines 504-522)

**Step 1: Write the failing test**

Add to `backend/tests/test_agent_subagent_options.py`:

```python
@pytest.mark.asyncio
async def test_stream_chat_emits_subagent_start_for_task_tool():
    """When the agent calls Task tool, stream_chat should emit subagent_start SSE event."""
    import json
    db = MagicMock(spec=Database)
    db.list_tables.return_value = []

    class FakeClient:
        def __init__(self, options=None):
            pass

        async def connect(self):
            pass

        async def query(self, msg, session_id=None):
            pass

        async def receive_response(self):
            from claude_agent_sdk import AssistantMessage, ToolUseBlock
            from claude_agent_sdk.types import ResultMessage

            # Simulate: assistant calls Task tool (subagent invocation)
            yield AssistantMessage(
                type="assistant",
                message={
                    "content": [
                        ToolUseBlock(
                            type="tool_use",
                            id="task_1",
                            name="Task",
                            input={
                                "subagent_type": "sql-analyst",
                                "description": "Run SQL query",
                                "prompt": "Find top products",
                            },
                        )
                    ]
                },
            )
            yield ResultMessage(
                type="result",
                subtype="success",
                session_id="test-session",
                is_error=False,
                result="",
                errors=[],
                duration_ms=100,
                duration_api_ms=80,
                num_turns=1,
                cost=None,
            )

        async def disconnect(self):
            pass

    with patch("app.agent.ClaudeSDKClient", FakeClient), \
         patch("app.agent.proxy_token_store") as mock_proxy:
        mock_proxy.create_token.return_value = "fake-token"
        mock_proxy.revoke_token = MagicMock()

        from app.agent import stream_chat
        events = []
        async for event in stream_chat("test", db=db):
            events.append(event)

    # Find subagent_start event
    subagent_events = [e for e in events if "subagent_start" in e]
    assert len(subagent_events) >= 1
    data_line = subagent_events[0].split("data: ")[1].strip()
    parsed = json.loads(data_line)
    assert parsed["name"] == "sql-analyst"
    assert parsed["id"] == "task_1"
```

**Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_agent_subagent_options.py::test_stream_chat_emits_subagent_start_for_task_tool -v`
Expected: FAIL — no subagent_start event emitted

**Step 3: Write minimal implementation**

In `backend/app/agent.py`, inside the `stream_chat()` function, in the `AssistantMessage` handler (around line 504), add detection for Task tool calls:

Inside the `if isinstance(block, ToolUseBlock):` block, after the existing tool_call emission, add:

```python
                        # Detect subagent invocation via Task tool
                        if tool_name == "Task":
                            subagent_name = block.input.get("subagent_type", "unknown")
                            subagent_prompt = block.input.get("prompt", "")
                            yield f"event: subagent_start\ndata: {json.dumps({'id': block.id, 'name': subagent_name, 'prompt': subagent_prompt})}\n\n"
```

Also, in the `UserMessage` handler where tool results are processed, add detection for Task tool results to emit `subagent_end`:

```python
                            # Detect subagent completion
                            if name == "Task":
                                subagent_id = block.tool_use_id
                                subagent_name = tool_names.get(subagent_id, "")
                                end_data: dict = {"id": subagent_id, "name": subagent_name}
                                # Try to extract chart_spec from subagent result text
                                try:
                                    parsed_output = json.loads(output)
                                    if "chart_spec" in parsed_output:
                                        end_data["chart_spec"] = parsed_output["chart_spec"]
                                    else:
                                        end_data["result"] = output
                                except (json.JSONDecodeError, TypeError):
                                    end_data["result"] = output
                                yield f"event: subagent_end\ndata: {json.dumps(end_data, default=str)}\n\n"
```

Update the `tool_names` dict to store `subagent_type` for Task calls:

```python
                        if tool_name == "Task":
                            tool_names[block.id] = block.input.get("subagent_type", "Task")
                        else:
                            tool_names[block.id] = tool_name
```

**Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_agent_subagent_options.py -v`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/app/agent.py backend/tests/test_agent_subagent_options.py
git commit -m "feat: emit subagent_start/subagent_end SSE events for Task tool calls"
```

---

### Task 8: Add `subagent_start`/`subagent_end` to frontend SSE handler

**Files:**
- Modify: `frontend/src/types.ts` (add SubagentEvent type)
- Modify: `frontend/src/agent/agentService.ts` (handle new SSE events)

**Step 1: Add types**

Add to `frontend/src/types.ts` after `ToolCallResult`:

```typescript
export interface SubagentEvent {
  id: string;
  name: string;
  prompt?: string;
  result?: string;
  chart_spec?: {
    data: unknown[];
    layout?: Record<string, unknown>;
  };
}
```

**Step 2: Update AgentCallbacks**

In `frontend/src/agent/agentService.ts`, add to `AgentCallbacks` interface:

```typescript
interface AgentCallbacks {
  onTextChunk: (text: string) => void;
  onThinkingDone: () => void;
  onToolCall: (pending: ToolCallResult) => void;
  onToolResult: (result: ToolCallResult) => void;
  onSubagentStart?: (data: { id: string; name: string; prompt: string }) => void;
  onSubagentEnd?: (data: { id: string; name: string; result?: string; chart_spec?: { data: unknown[]; layout?: Record<string, unknown> } }) => void;
  onDone: (sessionId: string | null) => void;
  onError: (error: string) => void;
}
```

**Step 3: Handle events in `handleSSEEvent()`**

Add cases to the switch in `handleSSEEvent()`:

```typescript
    case 'subagent_start':
      callbacks.onSubagentStart?.({
        id: data.id as string,
        name: data.name as string,
        prompt: (data.prompt as string) ?? '',
      });
      break;
    case 'subagent_end':
      callbacks.onSubagentEnd?.({
        id: data.id as string,
        name: data.name as string,
        result: (data.result as string) ?? undefined,
        chart_spec: (data.chart_spec as { data: unknown[]; layout?: Record<string, unknown> }) ?? undefined,
      });
      break;
```

**Step 4: Commit**

```bash
git add frontend/src/types.ts frontend/src/agent/agentService.ts
git commit -m "feat: handle subagent_start/subagent_end SSE events in frontend"
```

---

### Task 9: Wire subagent callbacks in AgentProvider

**Files:**
- Modify: `frontend/src/contexts/AgentContext.tsx` (add onSubagentStart/onSubagentEnd handlers)
- Modify: `frontend/src/types.ts` (add subagent segment type)

**Step 1: Update ContentSegment type**

In `frontend/src/types.ts`, update `ContentSegment`:

```typescript
export interface ContentSegment {
  type: 'thinking' | 'tool' | 'answer' | 'subagent_start' | 'subagent_end';
  text?: string;
  toolResult?: ToolCallResult;
  subagentId?: string;
  subagentName?: string;
  chart_spec?: {
    data: unknown[];
    layout?: Record<string, unknown>;
  };
}
```

**Step 2: Add callbacks in AgentProvider**

In `frontend/src/contexts/AgentContext.tsx`, inside the callbacks object passed to `runAgentLoop()` (around line 87), add after `onToolResult`:

```typescript
          onSubagentStart: (data) => {
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
              type: 'subagent_start',
              subagentId: data.id,
              subagentName: data.name,
              text: data.prompt,
            });
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, segments: [...segmentsRef.current] }
                  : m
              )
            );
          },
          onSubagentEnd: (data) => {
            segmentsRef.current.push({
              type: 'subagent_end',
              subagentId: data.id,
              subagentName: data.name,
              chart_spec: data.chart_spec,
              text: data.result,
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

Do the same for the `editMessage` callback block (around line 307).

**Step 3: Commit**

```bash
git add frontend/src/types.ts frontend/src/contexts/AgentContext.tsx
git commit -m "feat: wire subagent callbacks into AgentProvider state management"
```

---

### Task 10: Render subagent sections in MessageBubble

**Files:**
- Modify: `frontend/src/components/MessageBubble.tsx` (render subagent working indicator)

**Step 1: Update ThinkingBlock component**

In `frontend/src/components/MessageBubble.tsx`, inside the `ThinkingBlock` component's segment rendering (inside `thinkingSegments.map`), add handling for `subagent_start` segments:

After the existing `if (seg.type === 'tool' ...)` block around line 63, add:

```tsx
          if (seg.type === 'subagent_start') {
            const displayName = seg.subagentName === 'sql-analyst'
              ? t('sqlAnalystWorking') || 'SQL Analyst working...'
              : seg.subagentName === 'chart-builder'
              ? t('chartBuilderWorking') || 'Chart Builder working...'
              : `${seg.subagentName} working...`;
            return (
              <div key={i} className="message-bubble__subagent-indicator">
                <span className="message-bubble__subagent-label">{displayName}</span>
              </div>
            );
          }
```

For `subagent_end` segments with `chart_spec`, render them in the chart section. Update the `chartSegments` filter in MessageBubble around line 155:

```typescript
  const chartSegments = hasSegments
    ? message.segments!.filter(
        (s) =>
          (s.type === 'tool' && s.toolResult?.chart_spec) ||
          (s.type === 'subagent_end' && s.chart_spec)
      )
    : [];
```

And update the chart rendering around line 236 to handle both types:

```tsx
          {chartSegments.map((seg, i) => (
            <div key={`chart-${i}`} className="message-bubble__segment message-bubble__segment--answer">
              {seg.type === 'tool' && seg.toolResult ? (
                <InlineQueryResult result={seg.toolResult!} />
              ) : seg.chart_spec ? (
                <ChartWidget data={seg.chart_spec.data} layout={seg.chart_spec.layout} />
              ) : null}
            </div>
          ))}
```

Import `ChartWidget` at the top if not already imported:
```typescript
import { ChartWidget } from './ChartWidget';
```

**Step 2: Add minimal CSS**

Add to `frontend/src/components/MessageBubble.css`:

```css
.message-bubble__subagent-indicator {
  padding: 6px 10px;
  margin: 4px 0;
  border-left: 3px solid var(--color-border, #e0e0e0);
  font-size: 0.85em;
  color: var(--color-text-secondary, #666);
}

.message-bubble__subagent-label {
  font-style: italic;
}
```

**Step 3: Verify build**

Run: `cd frontend && npm run build`
Expected: Build succeeds with no TypeScript errors

**Step 4: Commit**

```bash
git add frontend/src/components/MessageBubble.tsx frontend/src/components/MessageBubble.css
git commit -m "feat: render subagent working indicators and chart results in MessageBubble"
```

---

### Task 11: Update container mode SSE parsing

**Files:**
- Modify: `backend/app/agent.py` (`_stream_chat_container` function, around lines 269-335)

**Step 1: Update container mode tool detection**

In `_stream_chat_container()`, inside the `msg_type == "assistant"` handler (around line 270), add Task tool detection after the existing tool_call emission:

```python
                            if tool_name == "Task":
                                subagent_name = tool_input.get("subagent_type", "unknown")
                                subagent_prompt = tool_input.get("prompt", "")
                                tool_names[tool_id] = subagent_name
                                yield f"event: subagent_start\ndata: {json.dumps({'id': tool_id, 'name': subagent_name, 'prompt': subagent_prompt})}\n\n"
```

In the `msg_type == "user"` handler (around line 292), add Task result detection:

```python
                            if name in ("sql-analyst", "chart-builder") or name == "Task":
                                end_data: dict = {"id": tool_id, "name": name}
                                try:
                                    parsed_sub = json.loads(text)
                                    if "chart_spec" in parsed_sub:
                                        end_data["chart_spec"] = parsed_sub["chart_spec"]
                                    else:
                                        end_data["result"] = text
                                except (json.JSONDecodeError, TypeError):
                                    end_data["result"] = text
                                yield f"event: subagent_end\ndata: {json.dumps(end_data, default=str)}\n\n"
```

Also update the container mode to include `agents` in the sidecar payload. In the `payload` dict (around line 201), add:

```python
            "agents": {
                name: {"description": a.description, "prompt": a.prompt, "tools": a.tools, "model": a.model}
                for name, a in build_subagent_definitions(db).items()
            },
```

**Step 2: Run existing container tests**

Run: `cd backend && python -m pytest tests/test_agent_container.py -v`
Expected: PASS (may need minor updates if tests reference generate_chart)

**Step 3: Commit**

```bash
git add backend/app/agent.py
git commit -m "feat: add subagent SSE events and agents config to container mode"
```

---

### Task 12: Run full test suite and verify

**Step 1: Run all backend tests**

Run: `cd backend && python -m pytest -v`
Expected: All tests pass

**Step 2: Run frontend build**

Run: `cd frontend && npm run build`
Expected: Build succeeds

**Step 3: Fix any remaining issues**

If any tests fail due to the removed `generate_chart` tool or changed system prompt, update them to match the new architecture.

**Step 4: Final commit**

```bash
git add -A
git commit -m "chore: fix remaining tests for subagent architecture"
```

---

### Task 13: Manual E2E verification

**Step 1: Start the app**

Run: `cd backend && make dev` (or however the dev server starts)

**Step 2: Test SQL subagent**

1. Upload a CSV file
2. Ask: "Show me the first 5 rows"
3. Verify: SQL subagent is invoked, query results displayed

**Step 3: Test Chart subagent**

1. Ask: "Show me a bar chart of the data"
2. Verify: Chart subagent is invoked, Plotly chart rendered

**Step 4: Verify subagent UI indicators**

1. Check that "SQL Analyst working..." appears during SQL queries
2. Check that "Chart Builder working..." appears during chart generation
3. Verify collapsible thinking sections still work
