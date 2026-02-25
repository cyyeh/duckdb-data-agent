# Design: Structured Chart Output via `render_chart` MCP Tool

**Date:** 2026-02-25
**Status:** Approved

## Problem

The chart-builder subagent currently outputs a free-text response containing a JSON code block. The backend parses this with a regex-based `_extract_chart_spec()` function. This is fragile — if the LLM omits `layout.title` or formats the JSON differently, the chart either renders without a title or fails to parse entirely.

## Goal

Replace free-text chart output with a structured MCP tool call. The chart-builder must call `render_chart(data, layout)` where `layout.title` is required by the JSON schema. This makes the title mandatory at the schema level, not just a prompt instruction.

## Architecture

### Current flow

```
chart-builder LLM
  → free-text with ```json block
  → _extract_chart_spec() regex parsing
  → chart_spec dict
  → subagent_end SSE event
  → frontend ChartWidget
```

### New flow

```
chart-builder LLM
  → calls render_chart(data, layout) MCP tool
  → backend captures tool_use.input from assistant message stream
  → chart_spec dict
  → subagent_end SSE event
  → frontend ChartWidget
```

## Changes

### 1. MCP Server (`backend/app/mcp_sse.py`)

Add a `render_chart` tool to the list returned by `list_tools()`:

```json
{
  "name": "render_chart",
  "description": "Render a Plotly chart. Call this as the final step after querying data.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "data": {
        "type": "array",
        "description": "Array of Plotly trace objects (bar, line, scatter, pie, etc.)"
      },
      "layout": {
        "type": "object",
        "description": "Plotly layout object",
        "properties": {
          "title": { "type": "string" }
        },
        "required": ["title"]
      }
    },
    "required": ["data", "layout"]
  }
}
```

The `call_tool` handler for `render_chart` returns `{"status": "rendered"}`. The backend captures the chart spec from the tool call arguments, not the response.

### 2. Chart-builder agent prompt (`backend/app/agent.py`)

Replace the "output a JSON code block" instruction with:

> After querying the data with SQL, call the `render_chart` tool with:
> - `data`: an array of Plotly trace objects
> - `layout`: a layout object that **must include a descriptive `title`**
>
> Do not output a JSON code block. Use the tool.

Add `"mcp__duckdb__render_chart"` to the chart-builder's `tools` list in `AgentDefinition`.

### 3. Backend stream handler (`backend/app/agent.py`)

**New accumulator:**

```python
subagent_chart_specs: dict[str, dict] = {}
```

**In the `assistant` message handler** — when processing content blocks from a chart-builder subagent context (`parent_tool_use_id` in `tool_names` and the subagent name is `"chart-builder"`), watch for `render_chart` tool_use blocks:

```python
elif block.get("type") == "tool_use" and "render_chart" in block.get("name", ""):
    subagent_chart_specs[parent_tool_use_id] = block.get("input", {})
```

**In the subagent_end handler** — replace `_extract_chart_spec(text)` with:

```python
chart_spec = subagent_chart_specs.get(tool_id)
```

### 4. Removed code

- `_extract_chart_spec()` function and all call sites in the chart-builder path
- `backend/tests/test_extract_chart_spec.py` (tests the removed function)
- Frontend `ChartWidget.tsx` fallback title (added in a prior session as a stopgap — can be removed since the schema now enforces the title)

### 5. Tests

- **Remove** `backend/tests/test_extract_chart_spec.py`
- **Update** `backend/tests/test_agent_chart.py` — assert chart_spec is captured from a `render_chart` tool_use block
- **Add** test for the `render_chart` MCP tool handler in `backend/tests/test_mcp_sse.py` (or a new file) verifying it accepts valid input and returns `{"status": "rendered"}`

## Trade-offs

| Concern | Notes |
|---|---|
| LLM may ignore tool instruction | Mitigated by removing the JSON code block as an alternative output path; only the tool call path produces a chart |
| Schema enforcement depth | Only `data` and `layout.title` are required; individual trace fields are not validated (Plotly is flexible) |
| Backward compatibility | `_extract_chart_spec` is removed; existing sessions mid-flight during deployment may miss a chart render, but will recover on the next message |
