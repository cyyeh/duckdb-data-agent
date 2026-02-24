# Chart Generation Tool — Design Doc

**Date:** 2026-02-24
**Status:** Approved

---

## Overview

Add a `generate_chart` MCP tool that allows the Claude agent to render interactive Plotly charts inline in the chat UI, alongside the existing SQL result tables.

---

## Goals

- Agent can proactively generate charts after running SQL queries
- Charts render interactively inside the existing tool result bubbles
- Full Plotly trace suite available (bar, line, scatter, pie, heatmap, box, etc.)
- Minimal backend complexity — no new endpoints or services

## Non-Goals

- Server-side image generation (no matplotlib/PNG approach)
- Custom chart builder UI for users
- Saving/exporting charts

---

## Architecture

```
User: "show me a bar chart of sales by region"
  │
  ├─ Agent calls execute_sql → gets tabular data
  │
  ├─ Agent calls generate_chart({ data: [...], layout: {...} })
  │     └─ Backend validates spec has a `data` array, echoes it back
  │
  └─ Frontend SSE receives tool_result with chart_spec key
        └─ InlineQueryResult renders <ChartWidget> (react-plotly.js)
              instead of the usual <table>
```

**Rendering approach:** Client-side via `react-plotly.js` + `plotly.js-dist-min`.
**Chart spec format:** Full declarative Plotly JSON (`data` traces array + optional `layout` object).
**Agent builds the spec** directly from SQL results — backend is pure pass-through after shape validation.

---

## Backend Changes

### `backend/app/tools.py` — new MCP tool

```python
@tool(
    "generate_chart",
    "Generate a Plotly chart from a JSON spec. Call this after execute_sql "
    "to visualize data. Pass a complete Plotly figure spec with 'data' (array "
    "of traces) and optional 'layout' object.",
    {
        "data": list,      # Plotly traces array (required)
        "layout": dict,    # Plotly layout object (optional)
    },
)
async def generate_chart(args: dict[str, Any]) -> dict[str, Any]:
    if not args.get("data"):
        return {"status": "error", "error": "Missing required field: data"}
    return {
        "status": "success",
        "chart_spec": {
            "data": args["data"],
            "layout": args.get("layout", {}),
        },
    }
```

Validation is intentionally minimal — Plotly is forgiving and the agent constructs the spec. The tool is registered alongside `execute_sql` in `create_duckdb_server()`.

### `backend/app/agent.py` — system prompt addition

Append a short section to the existing system prompt:

```
## Chart Generation
After running a SQL query, if a chart would help the user understand the data,
call the generate_chart tool with a valid Plotly figure spec:
- `data`: array of Plotly trace objects (bar, scatter, pie, heatmap, etc.)
- `layout`: optional layout object (title, axis labels, etc.)
Build the chart data directly from the SQL results. Full Plotly trace types are supported.
```

The `generate_chart` tool must be added to the `allowed_tools` list in `stream_chat()`:
```python
allowed_tools=["mcp__duckdb__execute_sql", "mcp__duckdb__generate_chart"]
```

---

## Frontend Changes

### `frontend/package.json` — new dependencies

```json
"react-plotly.js": "^2.6.0",
"plotly.js-dist-min": "^2.x",
"@types/react-plotly.js": "^2.6.0"
```

`plotly.js-dist-min` is used instead of the full `plotly.js` bundle (~1.5MB vs ~3MB).

### `frontend/src/types.ts` — extend `ToolCallResult`

```typescript
export interface ToolCallResult {
  // ... existing fields ...
  chart_spec?: {
    data: Plotly.Data[];
    layout?: Partial<Plotly.Layout>;
  };
}
```

### New `frontend/src/components/ChartWidget.tsx`

```tsx
import Plot from 'react-plotly.js';

interface ChartWidgetProps {
  data: Plotly.Data[];
  layout?: Partial<Plotly.Layout>;
}

export function ChartWidget({ data, layout }: ChartWidgetProps) {
  return (
    <Plot
      data={data}
      layout={{ autosize: true, ...layout }}
      useResizeHandler
      style={{ width: '100%' }}
      config={{ responsive: true, displayModeBar: true }}
    />
  );
}
```

### `frontend/src/components/InlineQueryResult.tsx` — chart branch

Add before the existing table branch:

```tsx
if (result.chart_spec) {
  return (
    <div className="inline-query inline-query--chart">
      <ChartWidget
        data={result.chart_spec.data}
        layout={result.chart_spec.layout}
      />
    </div>
  );
}
```

### `frontend/src/agent/agentService.ts` — no changes needed

`chart_spec` flows through the existing `tool_result` SSE event parsing automatically, since it already passes the full parsed JSON into `ToolCallResult`.

---

## Data Flow (Detailed)

```
SSE event: tool_result
  data: {
    "id": "tool_abc",
    "status": "success",
    "chart_spec": {
      "data": [{ "type": "bar", "x": [...], "y": [...] }],
      "layout": { "title": "Sales by Region" }
    }
  }
  │
  └─ agentService.ts → onToolResult(result)
        └─ AgentContext: merges into segment
              └─ MessageBubble → InlineQueryResult
                    └─ result.chart_spec? → <ChartWidget> : <table>
```

---

## Error Handling

- Tool returns `{"status": "error", "error": "..."}` if `data` is missing/empty
- Invalid Plotly specs fail silently in the browser (Plotly renders what it can)
- Frontend falls back to showing raw `tool_result` output if `chart_spec` is absent

---

## Files Changed

| File | Change |
|------|--------|
| `backend/app/tools.py` | Add `generate_chart` tool |
| `backend/app/agent.py` | Add system prompt section + allowed tool |
| `frontend/package.json` | Add `react-plotly.js`, `plotly.js-dist-min`, types |
| `frontend/src/types.ts` | Add `chart_spec` to `ToolCallResult` |
| `frontend/src/components/ChartWidget.tsx` | New component |
| `frontend/src/components/InlineQueryResult.tsx` | Add chart branch |
