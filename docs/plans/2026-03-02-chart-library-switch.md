# Chart Library Switch Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a global Plotly/Vega-Lite toggle in the agent panel header so users can choose which charting library renders visualizations.

**Architecture:** Frontend stores library preference in localStorage via a React context. The preference is sent with every chat request. Backend dynamically adjusts the agent's system prompt and render_chart tool schema. Frontend dispatches chart_spec to either Plotly or Vega-Lite renderer based on a `library` field.

**Tech Stack:** React, TypeScript, vega-embed, FastAPI/Pydantic, Claude Agent SDK

---

### Task 1: Add ChartLibrary context and hook

**Files:**
- Create: `frontend/src/hooks/useChartLibrary.ts`
- Create: `frontend/src/contexts/ChartLibraryContext.tsx`

**Step 1: Create the hook file**

Create `frontend/src/hooks/useChartLibrary.ts`:

```typescript
import { createContext, useContext } from 'react';

export type ChartLibrary = 'plotly' | 'vegalite';

interface ChartLibraryContextValue {
  chartLibrary: ChartLibrary;
  setChartLibrary: (lib: ChartLibrary) => void;
}

export const ChartLibraryContext = createContext<ChartLibraryContextValue>({
  chartLibrary: 'plotly',
  setChartLibrary: () => {},
});

export function useChartLibrary() {
  return useContext(ChartLibraryContext);
}
```

**Step 2: Create the provider**

Create `frontend/src/contexts/ChartLibraryContext.tsx`:

```typescript
import { useState, useCallback, type ReactNode } from 'react';
import { ChartLibraryContext, type ChartLibrary } from '../hooks/useChartLibrary';

function getInitialLibrary(): ChartLibrary {
  const stored = localStorage.getItem('chartLibrary');
  if (stored === 'plotly' || stored === 'vegalite') return stored;
  return 'plotly';
}

export function ChartLibraryProvider({ children }: { children: ReactNode }) {
  const [chartLibrary, setChartLibraryState] = useState<ChartLibrary>(getInitialLibrary);

  const setChartLibrary = useCallback((lib: ChartLibrary) => {
    setChartLibraryState(lib);
    localStorage.setItem('chartLibrary', lib);
  }, []);

  return (
    <ChartLibraryContext.Provider value={{ chartLibrary, setChartLibrary }}>
      {children}
    </ChartLibraryContext.Provider>
  );
}
```

**Step 3: Wire provider into App.tsx**

In `frontend/src/App.tsx`, import `ChartLibraryProvider` and wrap it around `AgentProvider`:

```tsx
// Add import at top:
import { ChartLibraryProvider } from './contexts/ChartLibraryContext';

// In the App() return, wrap AgentProvider:
<ChartLibraryProvider>
  <AgentProvider refreshTables={refreshTables}>
    <AppContent tables={tables} refreshTables={refreshTables} sessionId={sessionId} />
  </AgentProvider>
</ChartLibraryProvider>
```

**Step 4: Commit**

```bash
git add frontend/src/hooks/useChartLibrary.ts frontend/src/contexts/ChartLibraryContext.tsx frontend/src/App.tsx
git commit -m "feat: add ChartLibrary context with localStorage persistence"
```

---

### Task 2: Add toggle UI in AgentPanel header

**Files:**
- Modify: `frontend/src/components/AgentPanel.tsx`
- Modify: `frontend/src/components/AgentPanel.css`
- Modify: `frontend/src/i18n/en.json`
- Modify: `frontend/src/i18n/zh-TW.json`

**Step 1: Add i18n keys**

In `frontend/src/i18n/en.json`, add:
```json
"chartLibPlotly": "Plotly",
"chartLibVegaLite": "Vega-Lite"
```

In `frontend/src/i18n/zh-TW.json`, add:
```json
"chartLibPlotly": "Plotly",
"chartLibVegaLite": "Vega-Lite"
```

**Step 2: Add toggle to AgentPanel header**

In `frontend/src/components/AgentPanel.tsx`:

Import the hook:
```tsx
import { useChartLibrary } from '../hooks/useChartLibrary';
```

Inside the component, add:
```tsx
const { chartLibrary, setChartLibrary } = useChartLibrary();
```

In the `agent-panel__actions` div, add the toggle BEFORE the export button (as the first child inside the conditional `{messages.length > 0 && (...)}`). The toggle should always be visible (not gated on messages.length):

Replace the `agent-panel__actions` div with:
```tsx
<div className="agent-panel__actions">
  <div className="agent-panel__chart-toggle">
    <button
      className={`agent-panel__chart-toggle-btn${chartLibrary === 'plotly' ? ' agent-panel__chart-toggle-btn--active' : ''}`}
      onClick={() => setChartLibrary('plotly')}
    >
      {t('chartLibPlotly')}
    </button>
    <button
      className={`agent-panel__chart-toggle-btn${chartLibrary === 'vegalite' ? ' agent-panel__chart-toggle-btn--active' : ''}`}
      onClick={() => setChartLibrary('vegalite')}
    >
      {t('chartLibVegaLite')}
    </button>
  </div>
  {messages.length > 0 && (
    <button className="agent-panel__clear" onClick={() => exportConversation()}>
      {t('export')}
    </button>
  )}
  {messages.length > 0 && (
    <button className="agent-panel__clear" onClick={() => { if (confirm(t('clearConfirm'))) { clearMessages(activeConversationId); startNewConversation(); } }}>
      {t('clear')}
    </button>
  )}
</div>
```

**Step 3: Add CSS for the toggle**

In `frontend/src/components/AgentPanel.css`:

Update `.agent-panel__actions` to accommodate 3 items:
```css
.agent-panel__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
```

Add new styles:
```css
.agent-panel__chart-toggle {
  display: flex;
  border: 1px solid var(--color-border-dark);
  border-radius: 6px;
  overflow: hidden;
}

.agent-panel__chart-toggle-btn {
  height: 28px;
  padding: 0 10px;
  font-size: 12px;
  background: none;
  border: none;
  color: var(--color-text-subtle);
  cursor: pointer;
  box-sizing: border-box;
  white-space: nowrap;
}

.agent-panel__chart-toggle-btn:not(:last-child) {
  border-right: 1px solid var(--color-border-dark);
}

.agent-panel__chart-toggle-btn--active {
  background: var(--color-bg-code);
  color: var(--color-text-tertiary);
  font-weight: 600;
}

.agent-panel__chart-toggle-btn:hover:not(.agent-panel__chart-toggle-btn--active) {
  background: var(--color-bg-code);
  color: var(--color-text-tertiary);
}
```

**Step 4: Commit**

```bash
git add frontend/src/components/AgentPanel.tsx frontend/src/components/AgentPanel.css frontend/src/i18n/en.json frontend/src/i18n/zh-TW.json
git commit -m "feat: add Plotly/Vega-Lite toggle in agent panel header"
```

---

### Task 3: Update TypeScript types for chart_spec.library

**Files:**
- Modify: `frontend/src/types.ts`

**Step 1: Add library and spec fields to chart_spec**

In `frontend/src/types.ts`, update every `chart_spec` occurrence:

In `ToolCallResult` (line 32-36):
```typescript
chart_spec?: {
  library?: 'plotly' | 'vegalite';
  data: unknown[];
  layout?: Record<string, unknown>;
  frames?: unknown[];
  spec?: Record<string, unknown>;
};
```

In `ContentSegment` (line 64-68):
```typescript
chart_spec?: {
  library?: 'plotly' | 'vegalite';
  data: unknown[];
  layout?: Record<string, unknown>;
  frames?: unknown[];
  spec?: Record<string, unknown>;
};
```

**Step 2: Commit**

```bash
git add frontend/src/types.ts
git commit -m "feat: add library and spec fields to chart_spec type"
```

---

### Task 4: Send chart_library in API requests

**Files:**
- Modify: `frontend/src/agent/agentService.ts`
- Modify: `frontend/src/contexts/AgentContext.tsx`
- Modify: `frontend/src/hooks/useAgent.ts`

**Step 1: Add chartLibrary param to runAgentLoop and runAgentEditLoop**

In `frontend/src/agent/agentService.ts`:

Add `chartLibrary` parameter to `runAgentLoop`:
```typescript
export async function runAgentLoop(
  message: string,
  agentSessionId: string | null,
  langfuseSessionId: string | null,
  conversationHistory: { role: string; content: string }[] | null,
  conversationId?: string | null,
  callbacks?: AgentCallbacks,
  signal?: AbortSignal,
  userSessionId?: string,
  skills?: string[],
  chartLibrary?: string,
): Promise<void> {
```

In the `body: JSON.stringify({...})` call, add:
```typescript
chart_library: chartLibrary || 'plotly',
```

Similarly for `runAgentEditLoop`, add the parameter and send it in the body.

**Step 2: Read chartLibrary in AgentContext and pass to service calls**

In `frontend/src/contexts/AgentContext.tsx`:

Import the hook:
```typescript
import { useChartLibrary } from '../hooks/useChartLibrary';
```

Inside `AgentProvider`, read the context:
```typescript
const { chartLibrary } = useChartLibrary();
```

Pass `chartLibrary` as the last argument to both `runAgentLoop` (line 192) and `runAgentEditLoop` (line 506).

**Step 3: Commit**

```bash
git add frontend/src/agent/agentService.ts frontend/src/contexts/AgentContext.tsx
git commit -m "feat: send chart_library preference in chat API requests"
```

---

### Task 5: Backend — accept chart_library and update system prompt

**Files:**
- Modify: `backend/app/routes/chat.py`
- Modify: `backend/app/agent.py`

**Step 1: Add chart_library to ChatRequest and ChatEditRequest**

In `backend/app/routes/chat.py`, add to both Pydantic models:
```python
chart_library: str = "plotly"
```

Pass it to `stream_chat` in both endpoints:
```python
chart_library=request.chart_library,
```

**Step 2: Update stream_chat signature**

In `backend/app/agent.py`, add `chart_library: str = "plotly"` to the `stream_chat` function signature (line 188).

Pass it to `build_system_prompt`:
```python
system_prompt = build_system_prompt(db, chart_library=chart_library)
```

**Step 3: Update build_system_prompt for dual-library support**

In `backend/app/agent.py`, change `build_system_prompt` signature to:
```python
def build_system_prompt(db: Database, chart_library: str = "plotly") -> str:
```

Replace the tool listing line for render_chart (line 27):
```python
if chart_library == "vegalite":
    chart_tool_desc = "- mcp__duckdb-data-agent__render_chart — render a Vega-Lite chart"
else:
    chart_tool_desc = "- mcp__duckdb-data-agent__render_chart — render a Plotly chart"
```

Replace the charting workflow section (lines 53-74) with a conditional:

For Plotly (current text, no change).

For Vega-Lite:
```python
VEGALITE_CHARTING_WORKFLOW = """Charting workflow (follow this exactly):
1. Run execute_sql to get the data you need for a chart.
2. Call render_chart with TWO required parameters:
   - `library`: "vegalite"
   - `spec`: a Vega-Lite specification object containing:
     - `$schema`: "https://vega.github.io/schema/vega-lite/v5.json"
     - `title`: a descriptive chart title (required)
     - `mark`: the mark type (e.g. "bar", "line", "point", "arc", "boxplot", "area", "rect")
     - `encoding`: channel encodings (x, y, color, size, etc.) referencing field names
     - `data`: {"values": [...]} with the actual data rows
   Both `library` and `spec` are required — the tool WILL accept both. Do not second-guess this.
3. After the chart renders, write your narrative text discussing what the chart shows.
4. Repeat steps 1-3 for each additional chart. This produces interleaved charts and narrative.
- Do NOT render all charts first and then write all narrative at the end.
- Do NOT output chart JSON as a code block. Always use the render_chart tool.
- NEVER include Vega-Lite JSON, spec objects, or encoding details in your final answer text unless the user explicitly asks to see the raw JSON. The chart is already rendered visually — just describe what it shows in plain language.

Charting guidelines:
- Choose the most appropriate mark type (bar, line, point, arc, boxplot, area, rect, etc.).
- For pie charts, use mark "arc" with theta and color encodings.
- For multi-series data, use color encoding to distinguish series.
- Keep the chart clean and readable.
- IMPORTANT — keep data small. Pre-aggregate in SQL instead of passing raw rows:
  - Box plots: compute summary stats in SQL and pass as values. Use mark "boxplot".
  - Histograms: compute bin counts in SQL, then render as bar chart with the bin edges.
  - Scatter / line with many rows: sample (ORDER BY random() LIMIT 200) or aggregate so data has at most ~200 points.
  - General rule: data.values should have at most ~200 rows.
"""
```

Use `chart_library` parameter to select which workflow text to include.

**Step 4: Commit**

```bash
git add backend/app/routes/chat.py backend/app/agent.py
git commit -m "feat: backend accepts chart_library and adjusts system prompt"
```

---

### Task 6: Backend — update render_chart MCP tool for dual-library support

**Files:**
- Modify: `backend/app/mcp_sse.py`

**Step 1: Update render_chart tool schema**

In `backend/app/mcp_sse.py`, update the `render_chart` tool definition (lines 84-109):

```python
types.Tool(
    name="render_chart",
    description=(
        "Render a chart. For Plotly: pass `data` (array of traces) and `layout` (with title). "
        "For Vega-Lite: pass `library` as \"vegalite\" and `spec` (full Vega-Lite spec with title)."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "library": {
                "type": "string",
                "enum": ["plotly", "vegalite"],
                "default": "plotly",
                "description": "Chart library to use: 'plotly' (default) or 'vegalite'",
            },
            "data": {
                "type": "array",
                "description": "Array of Plotly trace objects (for Plotly mode)",
                "items": {"type": "object"},
            },
            "layout": {
                "type": "object",
                "description": "Plotly layout object (for Plotly mode)",
                "properties": {
                    "title": {"type": "string"},
                },
                "required": ["title"],
            },
            "spec": {
                "type": "object",
                "description": "Full Vega-Lite specification (for Vega-Lite mode)",
            },
        },
        "required": [],
    },
),
```

**Step 2: Update render_chart handler**

In `backend/app/mcp_sse.py`, update the `render_chart` handler (starting at line 223):

```python
elif name == "render_chart":
    library = arguments.get("library", "plotly")

    if library == "vegalite":
        spec = arguments.get("spec")
        if not isinstance(spec, dict):
            return [types.TextContent(type="text", text=json.dumps({
                "status": "error",
                "error": "spec (Vega-Lite specification object) is required when library is 'vegalite'"
            }))]
        # Check spec has data
        data_values = spec.get("data", {}).get("values", [])
        if not data_values:
            return [types.TextContent(type="text", text=json.dumps({
                "status": "error",
                "error": "Vega-Lite spec must contain data.values with at least one row."
            }))]
        return [types.TextContent(type="text", text=json.dumps({
            "status": "success",
            "chart_spec": {"library": "vegalite", "spec": spec},
        }))]
    else:
        # Plotly path (existing logic)
        data = arguments.get("data")
        layout = arguments.get("layout", {})
        if not isinstance(data, list):
            return [types.TextContent(type="text", text=json.dumps({"status": "error", "error": "data (array of Plotly traces) is required"}))]

        _DATA_FIELDS = ("x", "y", "z", "values", "labels", "lat", "lon", "r", "theta",
                        "lowerfence", "q1", "median", "q3", "upperfence")
        has_nonempty_trace = False
        for trace in data:
            if not isinstance(trace, dict):
                continue
            for field in _DATA_FIELDS:
                val = trace.get(field)
                if isinstance(val, list) and len(val) > 0:
                    has_nonempty_trace = True
                    break
            if has_nonempty_trace:
                break
        if not has_nonempty_trace:
            return [types.TextContent(type="text", text=json.dumps({
                "status": "error",
                "error": "All data traces are empty — no data to chart. "
                         "Check your SQL query results before calling render_chart."
            }))]
        return [types.TextContent(type="text", text=json.dumps({
            "status": "success",
            "chart_spec": {"library": "plotly", "data": data, "layout": layout},
        }))]
```

**Step 3: Update chart_spec capture in agent.py**

In `backend/app/agent.py`, the `tool_chart_specs[tool_id] = tool_input` capture (line 492) already stores the full tool input including `library` and `spec`. No change needed — the input dict is forwarded as-is.

However, the chart_spec attachment logic (line 624-625) should also be verified: it attaches `tool_chart_specs[tool_id]` to `result_data["chart_spec"]`. Since the MCP handler now returns a `chart_spec` with `library` included in the JSON response, and the frontend also reads `result_data["chart_spec"]` from the SSE, both paths should work.

**Important:** The `tool_chart_specs` capture stores the raw tool_use **input** (what the agent sent), but the SSE `chart_spec` field prefers the parsed MCP **result** when available (line 599-600). Since the MCP result now includes `library`, the frontend will receive it. However, the fallback path (line 624-625) uses the raw input which has `library`, `data`/`layout` or `spec` — this is fine since the frontend can check for `library`.

**Step 4: Commit**

```bash
git add backend/app/mcp_sse.py
git commit -m "feat: render_chart MCP tool supports both Plotly and Vega-Lite"
```

---

### Task 7: Frontend — install vega dependencies and create VegaLiteChartWidget

**Files:**
- Modify: `frontend/package.json` (via npm install)
- Create: `frontend/src/components/VegaLiteChartWidget.tsx`

**Step 1: Install vega dependencies**

```bash
cd frontend && npm install vega vega-lite vega-embed
```

**Step 2: Create VegaLiteChartWidget**

Create `frontend/src/components/VegaLiteChartWidget.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import embed from 'vega-embed';
import { useTheme } from '../hooks/useTheme';
import { useTranslation } from '../hooks/useTranslation';

interface VegaLiteChartWidgetProps {
  spec: Record<string, unknown>;
}

export function VegaLiteChartWidget({ spec }: VegaLiteChartWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current || !spec) return;

    const darkConfig = {
      background: 'transparent',
      axis: {
        labelColor: '#e2e8f0',
        titleColor: '#e2e8f0',
        gridColor: '#374151',
        domainColor: '#374151',
      },
      legend: {
        labelColor: '#e2e8f0',
        titleColor: '#e2e8f0',
      },
      title: {
        color: '#e2e8f0',
      },
      view: {
        stroke: 'transparent',
      },
    };

    const lightConfig = {
      background: 'transparent',
      view: {
        stroke: 'transparent',
      },
    };

    const fullSpec = {
      ...spec,
      width: 'container',
      autosize: { type: 'fit', contains: 'padding' },
      config: isDark ? darkConfig : lightConfig,
    };

    let disposed = false;
    embed(containerRef.current, fullSpec as never, {
      actions: true,
      renderer: 'svg',
    })
      .then((result) => {
        if (disposed) {
          result.finalize();
        }
      })
      .catch((err) => {
        if (!disposed) {
          setError(err?.message || 'Failed to render Vega-Lite chart');
        }
      });

    return () => {
      disposed = true;
    };
  }, [spec, isDark]);

  if (error) {
    return (
      <div style={{ padding: '1rem', textAlign: 'center', opacity: 0.6 }}>
        {t('chartRenderError')}: {error}
      </div>
    );
  }

  return <div ref={containerRef} style={{ width: '100%', minHeight: 400 }} />;
}
```

**Step 3: Add i18n key for error**

In `frontend/src/i18n/en.json`, add:
```json
"chartRenderError": "Chart rendering failed"
```

In `frontend/src/i18n/zh-TW.json`, add:
```json
"chartRenderError": "圖表渲染失敗"
```

**Step 4: Commit**

```bash
git add frontend/src/components/VegaLiteChartWidget.tsx frontend/package.json frontend/package-lock.json frontend/src/i18n/en.json frontend/src/i18n/zh-TW.json
git commit -m "feat: add VegaLiteChartWidget with vega-embed renderer"
```

---

### Task 8: Frontend — route chart_spec to correct renderer

**Files:**
- Modify: `frontend/src/components/InlineQueryResult.tsx`
- Modify: `frontend/src/components/MessageBubble.tsx`
- Modify: `frontend/src/agent/agentService.ts`

**Step 1: Update InlineQueryResult to dispatch by library**

In `frontend/src/components/InlineQueryResult.tsx`:

Import VegaLiteChartWidget:
```tsx
import { VegaLiteChartWidget } from './VegaLiteChartWidget';
```

Replace the chart rendering block (lines 87-101) with:

```tsx
if (result.chart_spec) {
  const isVegaLite = result.chart_spec.library === 'vegalite';
  return (
    <div className="inline-query inline-query--chart">
      <div className="inline-query__label inline-query__label--generic">
        {isVegaLite
          ? ((result.chart_spec.spec as Record<string, unknown>)?.title as string) || getToolDisplayName(result, t)
          : (result.chart_spec?.layout?.title as string) || getToolDisplayName(result, t)}
        <CopyButton text={JSON.stringify(isVegaLite ? result.chart_spec.spec : result.chart_spec, null, 2)} />
      </div>
      {isVegaLite ? (
        <VegaLiteChartWidget spec={result.chart_spec.spec!} />
      ) : (
        <ChartWidget
          data={result.chart_spec.data}
          layout={result.chart_spec.layout}
          frames={result.chart_spec.frames}
        />
      )}
    </div>
  );
}
```

**Step 2: Update MessageBubble chart rendering**

In `frontend/src/components/MessageBubble.tsx`, at line 367-374 where chart segments are rendered:

Import VegaLiteChartWidget at the top:
```tsx
import { VegaLiteChartWidget } from './VegaLiteChartWidget';
```

Update the chart rendering for `subagent_end` with `chart_spec` (line 372-373):
```tsx
) : seg.chart_spec ? (
  seg.chart_spec.library === 'vegalite' && seg.chart_spec.spec
    ? <VegaLiteChartWidget spec={seg.chart_spec.spec} />
    : <ChartWidget data={seg.chart_spec.data} layout={seg.chart_spec.layout} frames={seg.chart_spec.frames} />
) : null}
```

**Step 3: Update agentService SSE parsing**

In `frontend/src/agent/agentService.ts`, update the `tool_result` handler (line 218) to also extract `library` and `spec`:

```typescript
chart_spec: data.chart_spec
  ? {
      library: (data.chart_spec as Record<string, unknown>).library as 'plotly' | 'vegalite' | undefined,
      data: ((data.chart_spec as Record<string, unknown>).data as unknown[]) ?? [],
      layout: (data.chart_spec as Record<string, unknown>).layout as Record<string, unknown> | undefined,
      frames: (data.chart_spec as Record<string, unknown>).frames as unknown[] | undefined,
      spec: (data.chart_spec as Record<string, unknown>).spec as Record<string, unknown> | undefined,
    }
  : undefined,
```

Also update the `subagent_end` handler's `ChartSpec` type (line 231) to include `library` and `spec`:
```typescript
type ChartSpec = { library?: 'plotly' | 'vegalite'; data: unknown[]; layout?: Record<string, unknown>; frames?: unknown[]; spec?: Record<string, unknown> };
```

**Step 4: Commit**

```bash
git add frontend/src/components/InlineQueryResult.tsx frontend/src/components/MessageBubble.tsx frontend/src/agent/agentService.ts
git commit -m "feat: route chart_spec to Plotly or Vega-Lite renderer based on library field"
```

---

### Task 9: Manual testing and verification

**Step 1: Start the app**

```bash
cd /Users/cyyeh/Desktop/duckdb-data-agent/.worktrees/chart-library-switch
# Start backend and frontend (use whatever the project's dev command is)
```

**Step 2: Test Plotly (default)**

1. Load the app, verify toggle shows "Plotly" active
2. Upload a CSV file
3. Ask the agent to create a chart
4. Verify chart renders with Plotly

**Step 3: Test Vega-Lite**

1. Toggle to "Vega-Lite"
2. Refresh the page — verify Vega-Lite is still selected (localStorage)
3. Ask the agent to create a chart
4. Verify chart renders with Vega-Lite (vega-embed)

**Step 4: Test switching mid-conversation**

1. Start with Plotly, create a chart
2. Switch to Vega-Lite, create another chart
3. Verify first chart is still Plotly, second is Vega-Lite

**Step 5: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address issues found during manual testing"
```
