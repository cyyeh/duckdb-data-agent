# render_chart MCP Structured Output Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace free-text chart JSON output with a `render_chart` MCP tool call so that `layout.title` is schema-enforced, not prompt-instructed.

**Architecture:** Add a `render_chart` tool to the MCP server with a JSON schema requiring `layout.title`. Update the chart-builder subagent to call this tool instead of emitting a JSON code block. Capture the chart spec from the tool_use arguments in the backend stream handler, then remove the regex-based `_extract_chart_spec` fallback entirely.

**Tech Stack:** Python (FastAPI, MCP SDK, pytest), TypeScript (sidecar, not modified in this plan).

---

### Task 1: Add `render_chart` to the MCP server

**Files:**
- Modify: `backend/app/mcp_sse.py`
- Test: `backend/tests/test_mcp_sse.py`

**Step 1: Write the failing test**

Add to `backend/tests/test_mcp_sse.py`:

```python
@pytest.mark.asyncio
async def test_list_tools_includes_render_chart(db):
    """render_chart must appear in the MCP tool list."""
    import mcp.types as types

    server = _create_mcp_server(db, "test-session")
    handler = server.request_handlers[types.ListToolsRequest]
    result = await handler(types.ListToolsRequest(method="tools/list"))
    tool_names = [t.name for t in result.tools]
    assert "render_chart" in tool_names


@pytest.mark.asyncio
async def test_render_chart_schema_requires_title(db):
    """render_chart inputSchema must require layout.title."""
    import mcp.types as types

    server = _create_mcp_server(db, "test-session")
    handler = server.request_handlers[types.ListToolsRequest]
    result = await handler(types.ListToolsRequest(method="tools/list"))
    tool = next(t for t in result.tools if t.name == "render_chart")
    schema = tool.inputSchema
    assert "layout" in schema["required"]
    assert "title" in schema["properties"]["layout"]["required"]


@pytest.mark.asyncio
async def test_call_render_chart_returns_rendered(db):
    """Calling render_chart returns status=rendered."""
    import mcp.types as types

    server = _create_mcp_server(db, "test-session")
    handler = server.request_handlers[types.CallToolRequest]
    request = types.CallToolRequest(
        method="tools/call",
        params=types.CallToolRequestParams(
            name="render_chart",
            arguments={
                "data": [{"type": "bar", "x": ["A"], "y": [1]}],
                "layout": {"title": "My Chart"},
            },
        ),
    )
    result = await handler(request)
    content = result.content[0]
    assert content.type == "text"
    parsed = json.loads(content.text)
    assert parsed["status"] == "rendered"
```

**Step 2: Run tests to verify they fail**

```bash
cd backend && python -m pytest tests/test_mcp_sse.py::test_list_tools_includes_render_chart tests/test_mcp_sse.py::test_render_chart_schema_requires_title tests/test_mcp_sse.py::test_call_render_chart_returns_rendered -v
```

Expected: FAIL — `render_chart` not found in tool list.

**Step 3: Add `render_chart` to `mcp_sse.py`**

In `_create_mcp_server`, add to the `list_tools` return value:

```python
types.Tool(
    name="render_chart",
    description=(
        "Render a Plotly chart. Call this as the final step after querying data. "
        "Pass all Plotly traces in `data` and a layout object with a descriptive `title`."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "data": {
                "type": "array",
                "description": "Array of Plotly trace objects (bar, line, scatter, pie, etc.)",
            },
            "layout": {
                "type": "object",
                "description": "Plotly layout object",
                "properties": {
                    "title": {"type": "string"},
                },
                "required": ["title"],
            },
        },
        "required": ["data", "layout"],
    },
),
```

Add to `call_tool` handler (inside the `if name == "execute_sql": ... elif name == "ask_user_question": ...` chain):

```python
elif name == "render_chart":
    return [types.TextContent(type="text", text=json.dumps({"status": "rendered"}))]
```

**Step 4: Run tests to verify they pass**

```bash
cd backend && python -m pytest tests/test_mcp_sse.py::test_list_tools_includes_render_chart tests/test_mcp_sse.py::test_render_chart_schema_requires_title tests/test_mcp_sse.py::test_call_render_chart_returns_rendered -v
```

Expected: PASS

**Step 5: Run full test suite to check nothing is broken**

```bash
cd backend && python -m pytest -v
```

Expected: all existing tests still pass.

**Step 6: Commit**

```bash
git add backend/app/mcp_sse.py backend/tests/test_mcp_sse.py
git commit -m "feat: add render_chart MCP tool with required layout.title schema"
```

---

### Task 2: Update chart-builder agent prompt and tools

**Files:**
- Modify: `backend/app/agent.py`
- Test: `backend/tests/test_agent_chart.py`

**Step 1: Write the failing test**

Replace the contents of `backend/tests/test_agent_chart.py`:

```python
from unittest.mock import MagicMock
from app.agent import build_subagent_definitions, build_system_prompt
from app.database import Database


def test_build_system_prompt_delegates_to_subagents():
    """System prompt should instruct orchestrator to use subagents, not tools directly."""
    db = MagicMock(spec=Database)
    db.list_tables.return_value = []
    prompt = build_system_prompt(db)
    assert "sql-analyst" in prompt
    assert "chart-builder" in prompt
    assert "execute_sql" not in prompt
    assert "generate_chart" not in prompt


def test_chart_builder_prompt_instructs_render_chart_tool():
    """Chart-builder prompt must tell the LLM to call render_chart, not output a code block."""
    db = MagicMock(spec=Database)
    db.list_tables.return_value = []
    defs = build_subagent_definitions(db)
    prompt = defs["chart-builder"].prompt
    assert "render_chart" in prompt
    assert "```json" not in prompt  # no code block instruction


def test_chart_builder_tools_include_render_chart():
    """Chart-builder AgentDefinition must include render_chart in its tools list."""
    db = MagicMock(spec=Database)
    db.list_tables.return_value = []
    defs = build_subagent_definitions(db)
    tools = defs["chart-builder"].tools
    assert any("render_chart" in t for t in tools)
```

**Step 2: Run tests to verify they fail**

```bash
cd backend && python -m pytest tests/test_agent_chart.py::test_chart_builder_prompt_instructs_render_chart_tool tests/test_agent_chart.py::test_chart_builder_tools_include_render_chart -v
```

Expected: FAIL.

**Step 3: Update `chart_prompt` and tools in `agent.py`**

Replace the `chart_prompt` variable (lines ~81–98) in `build_subagent_definitions`:

```python
chart_prompt = (
    "You are a data visualization expert using Plotly. Given a user's request for "
    "a chart or visualization, query the data with SQL and then call the "
    "`render_chart` tool with the Plotly spec.\n\n"
    "Guidelines:\n"
    "- Choose the most appropriate chart type (bar, line, scatter, pie, histogram, "
    "box, heatmap, etc.).\n"
    "- For pie charts, use `labels` and `values` fields in the trace.\n"
    "- For multi-series data, group into separate traces.\n"
    "- `layout.title` is required — always provide a descriptive title.\n"
    "- Keep the chart clean and readable.\n\n"
    "When ready to render, call `render_chart` with:\n"
    "- `data`: array of Plotly trace objects\n"
    "- `layout`: object containing at minimum `{\"title\": \"<descriptive title>\"}`\n\n"
    "Do NOT output a JSON code block. Use the tool.\n"
    + table_schemas
)
```

Update the chart-builder `AgentDefinition` tools list:

```python
"chart-builder": AgentDefinition(
    description=(
        "Use this agent when the user wants a chart, graph, or visualization."
    ),
    prompt=chart_prompt,
    tools=["mcp__duckdb__execute_sql", "mcp__duckdb__render_chart"],
    model=CHART_SUBAGENT_MODEL,
),
```

**Step 4: Run tests to verify they pass**

```bash
cd backend && python -m pytest tests/test_agent_chart.py -v
```

Expected: PASS (all 3 tests).

**Step 5: Run full test suite**

```bash
cd backend && python -m pytest -v
```

Expected: all pass.

**Step 6: Commit**

```bash
git add backend/app/agent.py backend/tests/test_agent_chart.py
git commit -m "feat: update chart-builder to call render_chart tool instead of emitting JSON block"
```

---

### Task 3: Capture `render_chart` tool_use in the stream handler

**Files:**
- Modify: `backend/app/agent.py` (the `stream_chat` function)
- Test: `backend/tests/test_subagent_definitions.py` (read existing file first to see pattern; add a new test file if appropriate)

**Step 1: Write the failing test**

Create `backend/tests/test_stream_chart_capture.py`:

```python
"""Tests for render_chart tool_use capture in stream_chat message handling."""
import json
from app.agent import _build_chart_spec_from_stream_messages


def _make_assistant_msg(parent_tool_use_id, tool_use_name, tool_input):
    """Helper: build a minimal SDK 'assistant' message dict."""
    return {
        "type": "assistant",
        "parent_tool_use_id": parent_tool_use_id,
        "message": {
            "content": [
                {
                    "type": "tool_use",
                    "id": "tu_render_1",
                    "name": tool_use_name,
                    "input": tool_input,
                }
            ]
        },
    }


def test_captures_render_chart_input_as_chart_spec():
    """render_chart tool_use.input is captured as chart_spec for the parent task id."""
    chart_input = {
        "data": [{"type": "bar", "x": ["A", "B"], "y": [1, 2]}],
        "layout": {"title": "Sales by Category"},
    }
    msg = _make_assistant_msg(
        parent_tool_use_id="task_001",
        tool_use_name="mcp__duckdb__render_chart",
        tool_input=chart_input,
    )

    specs: dict = {}
    tool_names = {"task_001": "chart-builder"}
    _build_chart_spec_from_stream_messages(msg, tool_names, specs)

    assert specs["task_001"] == chart_input


def test_ignores_non_render_chart_tool_use():
    """Other tool_use blocks in a chart-builder turn are not captured as chart_spec."""
    msg = _make_assistant_msg(
        parent_tool_use_id="task_001",
        tool_use_name="mcp__duckdb__execute_sql",
        tool_input={"sql": "SELECT 1"},
    )

    specs: dict = {}
    tool_names = {"task_001": "chart-builder"}
    _build_chart_spec_from_stream_messages(msg, tool_names, specs)

    assert specs == {}


def test_ignores_messages_not_from_chart_builder():
    """Tool_use blocks from non-chart-builder subagents are ignored."""
    msg = _make_assistant_msg(
        parent_tool_use_id="task_002",
        tool_use_name="mcp__duckdb__render_chart",
        tool_input={"data": [], "layout": {"title": "x"}},
    )

    specs: dict = {}
    tool_names = {"task_002": "sql-analyst"}  # not chart-builder
    _build_chart_spec_from_stream_messages(msg, tool_names, specs)

    assert specs == {}
```

**Step 2: Run test to verify it fails**

```bash
cd backend && python -m pytest tests/test_stream_chart_capture.py -v
```

Expected: FAIL — `_build_chart_spec_from_stream_messages` not defined.

**Step 3: Extract the helper function and update `agent.py`**

Add a new module-level helper function in `agent.py` (just before `stream_chat`):

```python
def _build_chart_spec_from_stream_messages(
    msg: dict, tool_names: dict[str, str], subagent_chart_specs: dict
) -> None:
    """Inspect an assistant message and capture render_chart input as chart_spec.

    When the chart-builder subagent calls render_chart, the tool_use block
    appears in an assistant message whose parent_tool_use_id is the Task
    tool_use_id for the chart-builder.  We extract input directly so we never
    need to parse free-text JSON.
    """
    parent_id = msg.get("parent_tool_use_id")
    if not parent_id or tool_names.get(parent_id) != "chart-builder":
        return
    for block in msg.get("message", {}).get("content", []):
        if block.get("type") == "tool_use" and "render_chart" in block.get("name", ""):
            subagent_chart_specs[parent_id] = block.get("input", {})
            return
```

**Step 4: Run test to verify it passes**

```bash
cd backend && python -m pytest tests/test_stream_chart_capture.py -v
```

Expected: PASS (all 3 tests).

**Step 5: Wire the helper into `stream_chat`**

Inside `stream_chat`, make two changes:

1. Add the accumulator alongside `subagent_texts`:

```python
subagent_chart_specs: dict[str, dict] = {}
```

2. In the `elif msg_type == "assistant":` block, after the existing subagent text capture, call the new helper:

```python
_build_chart_spec_from_stream_messages(msg, tool_names, subagent_chart_specs)
```

3. In the subagent_end section (where `name == "chart-builder"`), replace the `_extract_chart_spec` calls with:

```python
if name == "chart-builder":
    chart_spec = subagent_chart_specs.get(tool_id)
    end_data: dict = {"id": tool_id, "name": name}
    if chart_spec:
        end_data["chart_spec"] = chart_spec
    else:
        end_data["result"] = tool_use_result_text or subagent_texts.get(tool_id, text)
        logger.warning(
            "[container] render_chart tool_use not found for chart-builder %s",
            tool_id,
        )
    yield f"event: subagent_end\ndata: {json.dumps(end_data, default=str)}\n\n"
    continue
```

**Step 6: Run full test suite**

```bash
cd backend && python -m pytest -v
```

Expected: all pass.

**Step 7: Commit**

```bash
git add backend/app/agent.py backend/tests/test_stream_chart_capture.py
git commit -m "feat: capture chart_spec from render_chart tool_use in stream handler"
```

---

### Task 4: Remove `_extract_chart_spec` and related dead code

**Files:**
- Modify: `backend/app/agent.py`
- Delete: `backend/tests/test_extract_chart_spec.py`
- Modify: `frontend/src/components/ChartWidget.tsx`

**Step 1: Delete `test_extract_chart_spec.py`**

```bash
git rm backend/tests/test_extract_chart_spec.py
```

**Step 2: Remove `_extract_chart_spec` from `agent.py`**

Delete the entire `_extract_chart_spec` function (lines ~137–166 in the original file — verify line numbers with `grep -n "_extract_chart_spec" backend/app/agent.py` first).

**Step 3: Remove the frontend stopgap fallback in `ChartWidget.tsx`**

The fallback title added in the prior session (lines ~9-10) can now be removed since `layout.title` is guaranteed by the schema.

Replace:

```tsx
export function ChartWidget({ data, layout }: ChartWidgetProps) {
  const hasTitle = layout?.title && (typeof layout.title === 'string' ? layout.title.trim() !== '' : true);
  const effectiveLayout = hasTitle ? layout : { title: 'Chart', ...layout };
  return (
    <Plot
      data={data as Plotly.Data[]}
      layout={{ autosize: true, height: 400, ...effectiveLayout } as Partial<Plotly.Layout>}
```

With:

```tsx
export function ChartWidget({ data, layout }: ChartWidgetProps) {
  return (
    <Plot
      data={data as Plotly.Data[]}
      layout={{ autosize: true, height: 400, ...layout } as Partial<Plotly.Layout>}
```

**Step 4: Run full test suite**

```bash
cd backend && python -m pytest -v
```

Expected: all pass (test_extract_chart_spec.py tests are gone, nothing references the deleted function).

**Step 5: Commit**

```bash
git add backend/app/agent.py frontend/src/components/ChartWidget.tsx
git commit -m "refactor: remove _extract_chart_spec and frontend title fallback — replaced by render_chart tool schema"
```

---

## Verification

After all tasks are complete, run the full suite one final time:

```bash
cd backend && python -m pytest -v
```

All tests should pass. The chart-builder subagent will now:
1. Query data via `mcp__duckdb__execute_sql`
2. Call `mcp__duckdb__render_chart` with schema-validated `{data, layout: {title, ...}}`
3. The backend captures `tool_use.input` directly — no regex parsing
