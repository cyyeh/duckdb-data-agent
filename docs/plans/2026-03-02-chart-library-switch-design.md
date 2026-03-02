# Chart Library Switch Design

## Overview

Add a global toggle in the agent panel header to switch between Plotly and Vega-Lite chart rendering. The agent emits native specs for whichever library is selected. Default is Plotly. Preference persists in localStorage.

## Decisions

- **Approach**: Single `render_chart` tool with a `library` parameter (Approach B)
- **Scope**: Global toggle in header, not per-chart
- **Re-render**: Switching only affects new charts; existing charts stay as rendered
- **Spec generation**: Agent emits native Vega-Lite specs (not Plotly-to-Vega conversion)
- **Persistence**: localStorage key `chartLibrary`

## Section 1: UI — Global Toggle

A segmented pill toggle in the `AgentPanel` header, placed to the left of the Export button.

- Two options: **Plotly** (default) | **Vega-Lite**
- Styled consistently with header buttons (12px font, 28px height, same border/color CSS vars)
- State managed via `ChartLibraryContext` React context
- Persisted in `localStorage` key `chartLibrary` (`"plotly"` | `"vegalite"`)
- The `agent-panel__actions` grid expands from 2 columns to 3

## Section 2: Frontend — Dual Renderers

### Type changes

`chart_spec` gains a `library` field in `types.ts`:

```typescript
chart_spec?: {
  library?: 'plotly' | 'vegalite';
  data: unknown[];
  layout?: Record<string, unknown>;
  frames?: unknown[];
  spec?: Record<string, unknown>;  // Vega-Lite spec
};
```

### New component: VegaLiteChartWidget

- New file `frontend/src/components/VegaLiteChartWidget.tsx`
- Uses `vega-embed` to render Vega-Lite JSON specs
- Dark/light theme via Vega-Lite config object
- Error boundary: wraps vega-embed in try/catch with fallback UI

### Routing in InlineQueryResult

`InlineQueryResult.tsx` checks `chart_spec.library`:
- `"vegalite"` → renders `VegaLiteChartWidget`
- `"plotly"` or absent → renders `ChartWidget` (existing)

### New dependencies

- `vega`, `vega-lite`, `vega-embed`

## Section 3: Backend — Library-Aware Agent

### API changes

`ChatRequest` model gains:
```python
chart_library: str = "plotly"
```

Frontend sends `chart_library` in the POST body of `/api/chat` and `/api/chat/edit`.

### System prompt

`build_system_prompt(db, chart_library)` dynamically switches charting instructions:

- **Plotly mode**: Current instructions (Plotly traces in `data`, layout with `title`)
- **Vega-Lite mode**: Instructions to emit `render_chart(library="vegalite", spec={"$schema": "...", "mark": "...", "encoding": {...}, "data": {"values": [...]}, "title": "..."})` format

### MCP tool schema update

`render_chart` tool gains:
- `library` parameter: `"plotly"` (default) or `"vegalite"`
- `spec` parameter: object for Vega-Lite spec (required when library is vegalite)
- Validation: Plotly requires `data` + `layout`; Vega-Lite requires `spec`

### SSE event tagging

Backend attaches `library` field to `chart_spec` in SSE `tool_result` events based on what the agent passed.

## Section 4: Data Flow

```
1. User toggles "Vega-Lite" in header → saved to localStorage, context updates
2. User sends message → frontend includes chart_library: "vegalite" in POST
3. Backend builds system prompt with Vega-Lite charting instructions
4. Agent calls render_chart(library="vegalite", spec={...})
5. Backend validates, attaches library: "vegalite" to chart_spec in SSE
6. Frontend receives tool_result with chart_spec.library === "vegalite"
7. InlineQueryResult renders VegaLiteChartWidget
```

## Error Handling

- If agent emits wrong format for the selected library, renderer shows graceful error ("Chart rendering failed") instead of crashing
- `VegaLiteChartWidget` wraps vega-embed in try/catch with fallback UI
- Missing `library` field on `chart_spec` defaults to Plotly (backward compat)

## Files to Modify

| File | Change |
|------|--------|
| `frontend/src/components/AgentPanel.tsx` | Add toggle UI |
| `frontend/src/components/AgentPanel.css` | Expand actions grid, toggle styles |
| `frontend/src/contexts/ChartLibraryContext.tsx` | New context (localStorage + state) |
| `frontend/src/components/VegaLiteChartWidget.tsx` | New Vega-Lite renderer |
| `frontend/src/components/InlineQueryResult.tsx` | Route to correct renderer |
| `frontend/src/components/MessageBubble.tsx` | Pass library to chart segments |
| `frontend/src/types.ts` | Add `library` and `spec` to chart_spec |
| `frontend/src/agent/agentService.ts` | Send `chart_library` in POST, parse `library` from SSE |
| `frontend/src/hooks/useAgent.ts` | Read chart library from context, pass to agentService |
| `frontend/package.json` | Add vega, vega-lite, vega-embed |
| `backend/app/routes/chat.py` | Add `chart_library` to request models |
| `backend/app/agent.py` | Dynamic system prompt, pass chart_library to stream_chat |
| `backend/app/mcp_sse.py` | Update render_chart tool schema, validation, SSE tagging |
