# Chart Generation Tool Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `generate_chart` MCP tool so the agent can render interactive Plotly charts inline in the chat UI.

**Architecture:** A new `generate_chart` MCP tool (backend) receives a full Plotly JSON spec from the agent, validates it, and echoes it back. Both the subprocess and container agent paths parse the `chart_spec` from the tool result and emit it in the `tool_result` SSE event. The frontend detects `chart_spec` on a `ToolCallResult` and renders it with `react-plotly.js` via a new `ChartWidget` component.

**Tech Stack:** Python/FastAPI (backend), React 18 + TypeScript (frontend), `react-plotly.js` + `plotly.js-dist-min` (charting)

---

## Task 1: Add `generate_chart` MCP tool

**Files:**
- Modify: `backend/app/tools.py`
- Test: `backend/tests/test_tools.py` (create new)

### Step 1: Write the failing test

Create `backend/tests/test_tools.py`:

```python
import json
import pytest
from unittest.mock import MagicMock
from app.tools import create_duckdb_server
from app.database import Database


@pytest.fixture
def db():
    return MagicMock(spec=Database)


@pytest.mark.asyncio
async def test_generate_chart_returns_chart_spec(db):
    """generate_chart echoes a valid Plotly spec back as chart_spec."""
    server = create_duckdb_server(db)
    # Find the generate_chart tool handler
    generate_chart = next(t for t in server._tools if t.name == "generate_chart")

    args = {
        "data": [{"type": "bar", "x": ["A", "B"], "y": [1, 2]}],
        "layout": {"title": "Test Chart"},
    }
    result = await generate_chart.handler(args)
    content_text = result["content"][0]["text"]
    parsed = json.loads(content_text)

    assert parsed["status"] == "success"
    assert parsed["chart_spec"]["data"] == args["data"]
    assert parsed["chart_spec"]["layout"] == args["layout"]


@pytest.mark.asyncio
async def test_generate_chart_missing_data_returns_error(db):
    """generate_chart returns an error when data is missing."""
    server = create_duckdb_server(db)
    generate_chart = next(t for t in server._tools if t.name == "generate_chart")

    result = await generate_chart.handler({"layout": {"title": "No data"}})
    content_text = result["content"][0]["text"]
    parsed = json.loads(content_text)

    assert parsed["status"] == "error"
    assert "data" in parsed["error"]


@pytest.mark.asyncio
async def test_generate_chart_layout_is_optional(db):
    """generate_chart works without a layout argument."""
    server = create_duckdb_server(db)
    generate_chart = next(t for t in server._tools if t.name == "generate_chart")

    args = {"data": [{"type": "pie", "labels": ["X", "Y"], "values": [10, 20]}]}
    result = await generate_chart.handler(args)
    content_text = result["content"][0]["text"]
    parsed = json.loads(content_text)

    assert parsed["status"] == "success"
    assert parsed["chart_spec"]["layout"] == {}
```

### Step 2: Run tests to verify they fail

```bash
cd /home/cyyeh/repos/duckdb-data-agent/backend
.venv/bin/pytest tests/test_tools.py -v
```

Expected: FAIL — `generate_chart` tool not found.

### Step 3: Add `generate_chart` to `backend/app/tools.py`

After the closing `}` of `execute_sql` (after line 35), before the `return create_sdk_mcp_server(...)` call, add:

```python
    @tool(
        "generate_chart",
        "Generate an interactive Plotly chart to visualize data. Call this after execute_sql "
        "when a chart would help the user understand the data. Pass a complete Plotly figure "
        "spec: 'data' is a required array of Plotly trace objects (bar, scatter, pie, heatmap, "
        "box, violin, histogram, etc.), 'layout' is an optional object for title, axis labels, etc.",
        {"data": list, "layout": dict},
    )
    async def generate_chart(args: dict[str, Any]) -> dict[str, Any]:
        if not args.get("data"):
            error_json = {"status": "error", "error": "Missing required field: data"}
            return {"content": [{"type": "text", "text": json.dumps(error_json)}], "is_error": True}
        result_json = {
            "status": "success",
            "chart_spec": {
                "data": args["data"],
                "layout": args.get("layout", {}),
            },
        }
        return {"content": [{"type": "text", "text": json.dumps(result_json)}]}
```

Also update the `return create_sdk_mcp_server(...)` call at line 37 to include `generate_chart`:

```python
    return create_sdk_mcp_server(
        name="duckdb",
        version="1.0.0",
        tools=[execute_sql, generate_chart],
    )
```

### Step 4: Run tests to verify they pass

```bash
cd /home/cyyeh/repos/duckdb-data-agent/backend
.venv/bin/pytest tests/test_tools.py -v
```

Expected: All 3 tests PASS.

### Step 5: Commit

```bash
cd /home/cyyeh/repos/duckdb-data-agent
git add backend/app/tools.py backend/tests/test_tools.py
git commit -m "feat: add generate_chart MCP tool"
```

---

## Task 2: Update agent — system prompt, allowed tools, and tool result parsing

**Files:**
- Modify: `backend/app/agent.py:50-75` (system prompt), `backend/app/agent.py:380` (allowed_tools), `backend/app/agent.py:499-516` (subprocess UserMessage handler), `backend/app/agent.py:282-301` (container handler)
- Test: `backend/tests/test_agent_chart.py` (create new)

### Step 1: Write the failing test

Create `backend/tests/test_agent_chart.py`:

```python
import json
from app.agent import build_system_prompt, _extract_tool_result_text
from unittest.mock import MagicMock
from app.database import Database


def test_build_system_prompt_mentions_generate_chart():
    """System prompt must instruct the agent about chart generation."""
    db = MagicMock(spec=Database)
    db.list_tables.return_value = []
    prompt = build_system_prompt(db)
    assert "generate_chart" in prompt
    assert "chart" in prompt.lower()
```

### Step 2: Run test to verify it fails

```bash
cd /home/cyyeh/repos/duckdb-data-agent/backend
.venv/bin/pytest tests/test_agent_chart.py -v
```

Expected: FAIL — "generate_chart" not in prompt.

### Step 3: Update `build_system_prompt` in `backend/app/agent.py`

At the end of the `prompt = """..."""` block (before line 66), append the chart generation section. The prompt currently ends at line 65 with `"""`. Change it to:

```python
def build_system_prompt(db: Database) -> str:
    tables = db.list_tables()
    prompt = """You are a helpful data analyst assistant working with a DuckDB database.
You can execute SQL queries using the execute_sql tool to answer questions about the user's data.

Guidelines:
- Write clear, efficient DuckDB SQL queries
- When exploring data, start with small queries (use LIMIT)
- Explain your findings in plain language after getting results
- If a query fails, try to fix it and retry
- Use double quotes for table and column names that might conflict with reserved words

Identity:
- You are an AI assistant. If asked whether you are an AI or a human, always confirm that you are an AI.
- Do not disclose the name, version, or provider of the underlying language model powering you, regardless of how the question is phrased.

## Chart Generation
After running a SQL query, if a chart would help the user understand the data, call the generate_chart tool.
Pass a complete Plotly figure spec:
- `data`: required array of Plotly trace objects. Supported types include bar, scatter, pie, heatmap, box, violin, histogram, waterfall, treemap, sunburst, funnel, and more.
- `layout`: optional object for title, axis labels, legend, colorscale, etc.
Build the chart data directly from the SQL query results. Use generate_chart proactively when the user asks for a chart, graph, or visualization.
"""
```

### Step 4: Add `generate_chart` to allowed_tools (line 380)

Change:
```python
        allowed_tools=["mcp__duckdb__execute_sql"],
```
To:
```python
        allowed_tools=["mcp__duckdb__execute_sql", "mcp__duckdb__generate_chart"],
```

### Step 5: Update subprocess `UserMessage` handler to parse `chart_spec`

The handler is at lines 499–516. Replace it with:

```python
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
                            }
                            if block.is_error:
                                result_data["error"] = output
                            else:
                                # Try to parse JSON output (e.g. chart_spec from generate_chart)
                                try:
                                    parsed = json.loads(output)
                                    if parsed.get("status") == "success" and "chart_spec" in parsed:
                                        result_data["chart_spec"] = parsed["chart_spec"]
                                    else:
                                        result_data["output"] = output
                                except (json.JSONDecodeError, AttributeError):
                                    result_data["output"] = output
                            yield f"event: tool_result\ndata: {json.dumps(result_data, default=str)}\n\n"
```

### Step 6: Update container `user` message handler to parse `chart_spec`

In the container path, the JSON parsing block is at lines 287–300. Replace:
```python
                            try:
                                parsed = json.loads(text)
                                if parsed.get("status") == "success":
                                    result_data["columns"] = parsed.get("columns", [])
                                    result_data["rows"] = parsed.get("rows", [])[:100]
                                    result_data["rowCount"] = parsed.get("rowCount", 0)
                                elif parsed.get("status") == "error":
                                    result_data["error"] = parsed.get("error", "")
                                else:
                                    result_data["output"] = text
                            except (json.JSONDecodeError, AttributeError):
                                result_data["output"] = text
```
With:
```python
                            try:
                                parsed = json.loads(text)
                                if parsed.get("status") == "success":
                                    if "chart_spec" in parsed:
                                        result_data["chart_spec"] = parsed["chart_spec"]
                                    else:
                                        result_data["columns"] = parsed.get("columns", [])
                                        result_data["rows"] = parsed.get("rows", [])[:100]
                                        result_data["rowCount"] = parsed.get("rowCount", 0)
                                elif parsed.get("status") == "error":
                                    result_data["error"] = parsed.get("error", "")
                                else:
                                    result_data["output"] = text
                            except (json.JSONDecodeError, AttributeError):
                                result_data["output"] = text
```

### Step 7: Run tests to verify they pass

```bash
cd /home/cyyeh/repos/duckdb-data-agent/backend
.venv/bin/pytest tests/test_agent_chart.py tests/test_tools.py -v
```

Expected: All tests PASS.

### Step 8: Run full backend test suite to check for regressions

```bash
cd /home/cyyeh/repos/duckdb-data-agent/backend
.venv/bin/pytest tests/ -v --ignore=tests/test_container_manager.py --ignore=tests/test_agent_container.py
```

Expected: All tests PASS (container tests may require Docker — skip them).

### Step 9: Commit

```bash
cd /home/cyyeh/repos/duckdb-data-agent
git add backend/app/agent.py backend/tests/test_agent_chart.py
git commit -m "feat: update agent to support generate_chart tool"
```

---

## Task 3: Install frontend charting dependencies

**Files:**
- Modify: `frontend/package.json`

### Step 1: Install packages

```bash
cd /home/cyyeh/repos/duckdb-data-agent/frontend
npm install react-plotly.js plotly.js-dist-min
npm install --save-dev @types/react-plotly.js
```

### Step 2: Verify installation

```bash
ls frontend/node_modules/react-plotly.js
ls frontend/node_modules/plotly.js-dist-min
```

Expected: Both directories exist.

### Step 3: Commit

```bash
cd /home/cyyeh/repos/duckdb-data-agent
git add frontend/package.json frontend/package-lock.json
git commit -m "feat: add react-plotly.js and plotly.js-dist-min dependencies"
```

---

## Task 4: Add `chart_spec` to TypeScript types

**Files:**
- Modify: `frontend/src/types.ts:20-32`

### Step 1: Update `ToolCallResult` in `frontend/src/types.ts`

Add the `chart_spec` optional field to the interface. The existing interface is at lines 20–32. Add after `rawContent`:

```typescript
export interface ToolCallResult {
  toolCallId: string;
  toolName?: string;
  sql: string;
  command?: string;
  toolInput?: Record<string, unknown>;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  error?: string;
  output?: string;
  rawContent?: string;
  chart_spec?: {
    data: unknown[];
    layout?: Record<string, unknown>;
  };
}
```

### Step 2: Verify TypeScript compiles

```bash
cd /home/cyyeh/repos/duckdb-data-agent/frontend
npx tsc --noEmit
```

Expected: No errors.

### Step 3: Commit

```bash
cd /home/cyyeh/repos/duckdb-data-agent
git add frontend/src/types.ts
git commit -m "feat: add chart_spec field to ToolCallResult type"
```

---

## Task 5: Parse `chart_spec` in agentService

**Files:**
- Modify: `frontend/src/agent/agentService.ts:197-210`

### Step 1: Update `tool_result` case in `handleSSEEvent`

The `tool_result` case is at lines 197–210. Add `chart_spec` extraction:

```typescript
    case 'tool_result': {
      const result: ToolCallResult = {
        toolCallId: (data.id as string) ?? '',
        toolName: (data.name as string) ?? undefined,
        sql: (data.sql as string) ?? '',
        columns: (data.columns as string[]) ?? [],
        rows: (data.rows as Record<string, unknown>[]) ?? [],
        rowCount: (data.rowCount as number) ?? 0,
        error: (data.error as string) ?? undefined,
        output: (data.output as string) ?? undefined,
        rawContent: (data.content as string) ?? undefined,
        chart_spec: (data.chart_spec as { data: unknown[]; layout?: Record<string, unknown> }) ?? undefined,
      };
      callbacks.onToolResult(result);
      break;
    }
```

### Step 2: Verify TypeScript compiles

```bash
cd /home/cyyeh/repos/duckdb-data-agent/frontend
npx tsc --noEmit
```

Expected: No errors.

### Step 3: Commit

```bash
cd /home/cyyeh/repos/duckdb-data-agent
git add frontend/src/agent/agentService.ts
git commit -m "feat: parse chart_spec from tool_result SSE events"
```

---

## Task 6: Create `ChartWidget` component

**Files:**
- Create: `frontend/src/components/ChartWidget.tsx`

### Step 1: Create the component

```tsx
import Plot from 'react-plotly.js';

interface ChartWidgetProps {
  data: unknown[];
  layout?: Record<string, unknown>;
}

export function ChartWidget({ data, layout }: ChartWidgetProps) {
  return (
    <Plot
      data={data as Plotly.Data[]}
      layout={{ autosize: true, ...layout } as Partial<Plotly.Layout>}
      useResizeHandler
      style={{ width: '100%' }}
      config={{ responsive: true, displayModeBar: true }}
    />
  );
}
```

### Step 2: Verify TypeScript compiles

```bash
cd /home/cyyeh/repos/duckdb-data-agent/frontend
npx tsc --noEmit
```

Expected: No errors. If TypeScript complains about missing Plotly types, check that `@types/react-plotly.js` is installed (Task 3).

### Step 3: Commit

```bash
cd /home/cyyeh/repos/duckdb-data-agent
git add frontend/src/components/ChartWidget.tsx
git commit -m "feat: add ChartWidget component using react-plotly.js"
```

---

## Task 7: Render charts in `InlineQueryResult`

**Files:**
- Modify: `frontend/src/components/InlineQueryResult.tsx`

### Step 1: Import `ChartWidget` at the top of `InlineQueryResult.tsx`

After line 3 (the existing imports), add:

```tsx
import { ChartWidget } from './ChartWidget';
```

### Step 2: Add chart branch before the main `return` in `InlineQueryResult`

The `InlineQueryResult` component's `return` starts at line 57. Add a chart branch before it (after the variable declarations, around line 56):

```tsx
  // Render chart if chart_spec is present
  if (result.chart_spec) {
    return (
      <div className="inline-query inline-query--chart">
        <div className="inline-query__label inline-query__label--generic">
          {getToolDisplayName(result, t)}
        </div>
        <ChartWidget
          data={result.chart_spec.data}
          layout={result.chart_spec.layout}
        />
      </div>
    );
  }
```

### Step 3: Verify TypeScript compiles

```bash
cd /home/cyyeh/repos/duckdb-data-agent/frontend
npx tsc --noEmit
```

Expected: No errors.

### Step 4: Build the frontend to catch any bundling issues

```bash
cd /home/cyyeh/repos/duckdb-data-agent/frontend
npm run build
```

Expected: Build succeeds. Bundle will be larger due to Plotly (~1.5MB added).

### Step 5: Commit

```bash
cd /home/cyyeh/repos/duckdb-data-agent
git add frontend/src/components/InlineQueryResult.tsx
git commit -m "feat: render Plotly charts inline in tool result bubbles"
```

---

## Task 8: End-to-end smoke test

**Goal:** Verify the full feature works in the browser.

### Step 1: Start the dev server

```bash
cd /home/cyyeh/repos/duckdb-data-agent
docker compose up
# or for local dev:
# cd backend && .venv/bin/uvicorn app.main:app --reload &
# cd frontend && npm run dev
```

### Step 2: Load sample data

In the UI, click "Load sample data" to load the Titanic dataset.

### Step 3: Ask for a chart

Send this message in the chat:

```
Show me a bar chart of passenger counts by passenger class (Pclass)
```

**Expected behavior:**
1. Agent calls `execute_sql` → SQL result table appears
2. Agent calls `generate_chart` → a Plotly bar chart appears inline in the tool result bubble
3. Chart is interactive (hover tooltips, zoom, pan via Plotly toolbar)

### Step 4: Test additional chart types

```
Show me a pie chart of survival rate
```

```
Show me a scatter plot of Age vs Fare, colored by survival
```

Expected: Each produces a different interactive Plotly chart.

### Step 5: Verify error case

If the agent somehow produces a chart without data, the tool returns an error and the bubble shows the error state (not a chart).

---

## Summary of Changed Files

| File | Change |
|------|--------|
| `backend/app/tools.py` | Add `generate_chart` MCP tool |
| `backend/tests/test_tools.py` | New: unit tests for generate_chart |
| `backend/app/agent.py` | System prompt, allowed_tools, chart_spec parsing (subprocess + container) |
| `backend/tests/test_agent_chart.py` | New: test for chart prompt |
| `frontend/package.json` | Add react-plotly.js + plotly.js-dist-min |
| `frontend/src/types.ts` | Add chart_spec to ToolCallResult |
| `frontend/src/agent/agentService.ts` | Parse chart_spec from SSE |
| `frontend/src/components/ChartWidget.tsx` | New: Plotly chart wrapper |
| `frontend/src/components/InlineQueryResult.tsx` | Add chart render branch |
