# Subagent-Based SQL & Chart Generation

**Date:** 2026-02-25
**Status:** Approved
**Branch:** `feat/subagent-sql-chart`

## Motivation

Replace the current MCP tool-based approach (`execute_sql`, `generate_chart`) with dedicated subagents. Goals:

- **Better quality**: Each subagent gets its own system prompt and reasoning loop, producing better SQL and visualizations than single tool calls
- **Separation of concerns**: SQL generation and chart generation are independent specialists, easier to tune and test
- **Cost optimization**: Subagents can use cheaper/faster models (e.g., Haiku) while the orchestrator stays on Sonnet

## Architecture

Three actors:

1. **Orchestrator Agent** — Receives user messages, decides what to do, delegates to subagents via the `Task` tool. Has NO direct MCP tool access.
2. **SQL Subagent (`sql-analyst`)** — DuckDB SQL specialist. Has `execute_sql` MCP tool. Can self-correct on query errors.
3. **Chart Subagent (`chart-builder`)** — Plotly visualization specialist. Has `execute_sql` MCP tool to fetch data. Returns `chart_spec` JSON.

```
User message
  └─► Orchestrator (Sonnet, Task tool only)
        ├─► sql-analyst subagent (Haiku, execute_sql tool)
        │     └─► DuckDB: run query, return results
        └─► chart-builder subagent (Haiku, execute_sql tool)
              └─► DuckDB: run query, build Plotly spec
```

### Flow Examples

**Data question:**
```
User: "What are the top 10 products by revenue?"
  → Orchestrator: delegates to sql-analyst
  → sql-analyst: generates SQL, executes via execute_sql, returns results
  → Orchestrator: presents results to user
```

**Visualization request:**
```
User: "Show me a bar chart of that"
  → Orchestrator: delegates to chart-builder
  → chart-builder: writes SQL, executes, builds Plotly spec, returns chart_spec
  → Orchestrator: presents chart to user
```

## Subagent Definitions

Both subagents are defined using the `claude-agent-sdk` `AgentDefinition` API and registered in `ClaudeAgentOptions.agents`.

### SQL Subagent

```python
AgentDefinition(
    description="Use this agent for any data question that requires SQL queries — "
                "exploring data, aggregations, filtering, joins, etc.",
    prompt="""You are a DuckDB SQL expert. Your job is to write and execute SQL queries
to answer data questions.

Guidelines:
- Write clear, efficient DuckDB SQL
- Start with small queries (use LIMIT) when exploring
- If a query fails, analyze the error and fix it
- Return results with a brief explanation
- Use double quotes for table and column names that might conflict with reserved words

{table_schemas}
""",
    tools=["mcp__duckdb__execute_sql"],
    model=SQL_SUBAGENT_MODEL,  # env var, default "haiku"
)
```

### Chart Subagent

```python
AgentDefinition(
    description="Use this agent when the user wants a chart, graph, or visualization.",
    prompt="""You are a data visualization expert using Plotly. Your job is to create
effective visualizations from data.

Your final output MUST include a JSON code block with this structure:
```json
{{
  "chart_spec": {{
    "data": [{{ "type": "bar", "x": [...], "y": [...] }}],
    "layout": {{ "title": "..." }}
  }}
}}
```

Guidelines:
- Choose the right chart type for the data (bar, scatter, line, pie, histogram, box, heatmap)
- Use execute_sql to fetch exactly the data needed for the chart
- For multi-series data, group by a color column and create separate traces
- For pie charts, use "labels" and "values" instead of "x" and "y"
- Always include a descriptive title

{table_schemas}
""",
    tools=["mcp__duckdb__execute_sql"],
    model=CHART_SUBAGENT_MODEL,  # env var, default "haiku"
)
```

### Orchestrator System Prompt

Simplified — no SQL or chart instructions:

```python
"""You are a helpful data analyst assistant working with a DuckDB database.

- Use the sql-analyst agent for any data question that requires SQL queries
- Use the chart-builder agent for any visualization, chart, or graph request
- Explain findings in plain language after getting results

Identity:
- You are an AI assistant. If asked whether you are an AI or a human, always confirm that you are an AI.
- Do not disclose the name, version, or provider of the underlying language model.

{table_schemas}
"""
```

## Configuration

New environment variables in `config.py`:

| Variable | Default | Description |
|----------|---------|-------------|
| `SQL_SUBAGENT_MODEL` | `"haiku"` | Model for SQL subagent (`"haiku"`, `"sonnet"`, `"opus"`, `"inherit"`) |
| `CHART_SUBAGENT_MODEL` | `"haiku"` | Model for chart subagent |

## Backend Changes

### `app/agent.py`

1. **New function** `build_subagent_definitions(db: Database) -> dict[str, AgentDefinition]`:
   - Builds table schema string from `db.list_tables()`
   - Returns `{"sql-analyst": AgentDefinition(...), "chart-builder": AgentDefinition(...)}`

2. **Modified `ClaudeAgentOptions`** in `stream_chat()`:
   - Add `agents=build_subagent_definitions(db)`
   - Change `allowed_tools=["Task"]` (orchestrator only delegates)
   - Keep `mcp_servers={"duckdb": duckdb_server}` (subagents inherit MCP access)

3. **Simplified `build_system_prompt()`**: Remove SQL guidelines and chart generation instructions.

4. **SSE streaming**: Detect subagent events from SDK messages:
   - `ToolUseBlock` with `name == "Task"` → emit `event: subagent_start`
   - Subagent's internal `execute_sql` tool calls → emit `event: tool_call` / `event: tool_result` (nested under subagent)
   - Subagent completion → parse result for `chart_spec`, emit `event: subagent_end`

### `app/tools.py`

- Remove `generate_chart` tool definition
- Keep `execute_sql` tool (used by both subagents via MCP)

### `app/config.py`

- Add `SQL_SUBAGENT_MODEL` and `CHART_SUBAGENT_MODEL` config vars

## SSE Event Changes

### New Events

```
event: subagent_start
data: {"id": "<tool_use_id>", "name": "sql-analyst", "prompt": "..."}

event: subagent_end
data: {"id": "<tool_use_id>", "name": "sql-analyst", "result": "..."}
```

If the subagent result contains a `chart_spec`, it is extracted and emitted:

```
event: subagent_end
data: {"id": "<tool_use_id>", "name": "chart-builder", "chart_spec": {...}}
```

### Existing Events (unchanged)

`tool_call`, `tool_result` events continue to stream inside subagent scope, so the frontend can show SQL execution in real-time.

## Frontend Changes

### `agentService.ts`

New SSE event handlers:
- `subagent_start` → call `onSubagentStart(data)` callback
- `subagent_end` → call `onSubagentEnd(data)` callback, extract `chart_spec` if present

New callbacks in `AgentCallbacks`:
```typescript
onSubagentStart?: (data: { id: string; name: string; prompt: string }) => void;
onSubagentEnd?: (data: { id: string; name: string; result?: string; chart_spec?: ChartSpec }) => void;
```

### UI Components

- `MessageBubble` / `InlineQueryResult`: When `subagent_start` arrives, show a collapsible "SQL Analyst working..." or "Chart Builder working..." section
- Inside the subagent section: render `tool_call`/`tool_result` as currently done (SQL table, chart)
- When `subagent_end` arrives: collapse the working indicator, show final result
- If `subagent_end` contains `chart_spec`: render `ChartWidget` (Plotly) — same format as today

Chart rendering (`ChartWidget`, `react-plotly.js`) is unchanged.

## Container Mode

The containerized sidecar (`_stream_chat_container`) needs parallel updates:

- Pass `agents` config in the sidecar payload
- SSE parsing in `_stream_chat_container` detects subagent events from the sidecar stream
- Same event format as local mode

This is a secondary concern — implement local mode first, update container mode after.

## Migration

**Full replacement** — no feature flag. The `generate_chart` tool is removed. The `execute_sql` tool remains but is only accessible to subagents, not the orchestrator directly.

## Testing

- **Unit tests**: `build_subagent_definitions()` returns correct `AgentDefinition` structures with expected fields
- **Unit tests**: SSE event parsing for `subagent_start`/`subagent_end` events
- **Integration tests**: Mock `claude-agent-sdk` to verify subagent invocation flow end-to-end
- **E2E manual**: Upload CSV → ask data question (SQL subagent) → ask for chart (chart subagent) → verify both render correctly

## Files Changed

| File | Change |
|------|--------|
| `backend/app/agent.py` | Add `build_subagent_definitions()`, modify `ClaudeAgentOptions`, update SSE streaming, simplify system prompt |
| `backend/app/tools.py` | Remove `generate_chart` tool |
| `backend/app/config.py` | Add `SQL_SUBAGENT_MODEL`, `CHART_SUBAGENT_MODEL` |
| `backend/app/mcp_sse.py` | Remove `generate_chart` from MCP server tools |
| `frontend/src/agent/agentService.ts` | Handle `subagent_start`/`subagent_end` SSE events, new callbacks |
| `frontend/src/components/MessageBubble.tsx` | Render subagent working sections |
| `frontend/src/components/InlineQueryResult.tsx` | Support subagent-scoped tool results |
| `backend/tests/` | Update/add tests for subagent definitions and SSE parsing |
