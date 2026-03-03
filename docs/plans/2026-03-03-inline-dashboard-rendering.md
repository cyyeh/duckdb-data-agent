# Inline Dashboard Rendering Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `/data:build-dashboard` work end-to-end by adding a `render_dashboard` MCP tool that passes HTML content through the existing SSE pipeline and renders it in a sandboxed iframe in the chat UI.

**Architecture:** Follow the exact same pattern as `render_chart` — new MCP tool captures the dashboard HTML, backend attaches it to the `tool_result` SSE event as `dashboard_html`, frontend renders it in a sandboxed `<iframe srcdoc>`. No separate file-serving endpoint needed. The `srcdoc` approach embeds HTML directly in the iframe attribute, avoiding the need to serve files from the sidecar's ephemeral tmpfs.

**Tech Stack:** Python (FastAPI, MCP SDK), TypeScript/React (frontend), Chart.js (inside dashboard HTML via CDN).

---

## Background

The data plugin's `/data:build-dashboard` command generates a self-contained HTML dashboard with Chart.js charts, filters, and tables. In the containerized architecture, the sidecar can only write to ephemeral tmpfs — files vanish on container cleanup and are inaccessible from the browser. The `render_dashboard` MCP tool solves this by passing the HTML through the existing tool-result pipeline, just like `render_chart` passes Plotly/Vega-Lite specs.

---

### Task 1: Add `render_dashboard` MCP Tool

**Files:**
- Modify: `backend/app/mcp_sse.py`

**Step 1: Add tool definition to `list_tools()`**

In `backend/app/mcp_sse.py`, add a new `types.Tool` entry after the `render_chart` tool definition (around line 119):

```python
types.Tool(
    name="render_dashboard",
    description=(
        "Render an interactive HTML dashboard inline in the chat. "
        "Pass the complete self-contained HTML string (including <html>, <style>, <script> tags). "
        "The dashboard will be displayed in a sandboxed iframe. "
        "Use this instead of writing HTML files to disk."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "html": {
                "type": "string",
                "description": "Complete self-contained HTML document string",
            },
            "title": {
                "type": "string",
                "description": "Dashboard title for the UI label",
            },
        },
        "required": ["html", "title"],
    },
),
```

**Step 2: Add tool handler in `call_tool()`**

In the `call_tool()` function, add a handler after the `render_chart` handler (around line 286):

```python
elif name == "render_dashboard":
    html = arguments.get("html", "")
    title = arguments.get("title", "Dashboard")
    if not html or not html.strip():
        return [types.TextContent(type="text", text=json.dumps({
            "status": "error",
            "error": "html content is required and cannot be empty",
        }))]
    return [types.TextContent(type="text", text=json.dumps({
        "status": "success",
        "dashboard_html": html,
        "title": title,
    }))]
```

**Step 3: Run existing tests to verify no regression**

Run: `cd backend && python -m pytest tests/test_mcp_sse.py -v`
Expected: All existing tests pass.

**Step 4: Commit**

```bash
git add backend/app/mcp_sse.py
git commit -m "feat: add render_dashboard MCP tool for inline HTML dashboards"
```

---

### Task 2: Add `render_dashboard` to Sidecar Allowed Tools

**Files:**
- Modify: `sidecar/src/server.ts`

**Step 1: Add tool to allowedTools array**

In `sidecar/src/server.ts`, add `"mcp__duckdb-data-agent__render_dashboard"` to the `allowedTools` array (around line 292):

```typescript
allowedTools: [
    "Bash",
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "Skill",
    "Task",
    "mcp__duckdb-data-agent__execute_sql",
    "mcp__duckdb-data-agent__ask_user_question",
    "mcp__duckdb-data-agent__render_chart",
    "mcp__duckdb-data-agent__render_dashboard",  // <-- add this
    "mcp__duckdb-data-agent__create_skill",
    "mcp__duckdb-data-agent__save_memory",
    "mcp__duckdb-data-agent__recall_memories",
    "mcp__duckdb-data-agent__forget_memory",
] as string[],
```

**Step 2: Commit**

```bash
git add sidecar/src/server.ts
git commit -m "feat: allow render_dashboard tool in sidecar allowedTools"
```

---

### Task 3: Capture Dashboard HTML in Backend SSE Stream

**Files:**
- Modify: `backend/app/agent.py`

This follows the exact same pattern as `tool_chart_specs` for `render_chart`.

**Step 1: Add dashboard capture dict**

In `backend/app/agent.py`, after the `tool_chart_specs` dict initialization (line 384), add:

```python
tool_dashboard_html: dict[str, dict] = {}  # Captures render_dashboard tool inputs
```

**Step 2: Capture tool input on tool_call**

In the assistant message handling block where `is_render_chart` is checked (around line 546), add capture for `render_dashboard`:

```python
is_render_dashboard = tool_name == "render_dashboard"
if is_render_dashboard:
    tool_dashboard_html[tool_id] = tool_input
```

**Step 3: Attach dashboard_html to tool_result SSE event**

In the tool_result handling block, after the chart_spec attachment (around line 737), add:

```python
if tool_id in tool_dashboard_html and "dashboard_html" not in result_data and "error" not in result_data:
    result_data["dashboard_html"] = tool_dashboard_html[tool_id].get("html", "")
    result_data["dashboard_title"] = tool_dashboard_html[tool_id].get("title", "Dashboard")
```

**Step 4: Persist dashboard metadata**

In the metadata accumulation block (around line 767), after `chart_specs` handling, add:

```python
if "dashboard_html" in result_data:
    # Persist only the title, not the full HTML (too large for metadata)
    assistant_metadata.setdefault("dashboards", []).append({
        "title": result_data.get("dashboard_title", "Dashboard"),
    })
```

**Step 5: Commit**

```bash
git add backend/app/agent.py
git commit -m "feat: capture render_dashboard HTML and attach to SSE events"
```

---

### Task 4: Add Dashboard Types and SSE Parsing to Frontend

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/agent/agentService.ts`
- Modify: `frontend/src/contexts/AgentContext.tsx`

**Step 1: Extend `ToolCallResult` type**

In `frontend/src/types.ts`, add `dashboard_html` and `dashboard_title` fields to `ToolCallResult` (after `chart_spec`, around line 38):

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
    library?: 'plotly' | 'vegalite';
    data?: unknown[];
    layout?: Record<string, unknown>;
    frames?: unknown[];
    spec?: Record<string, unknown>;
  };
  dashboard_html?: string;
  dashboard_title?: string;
  answerDurationMs?: number;
}
```

**Step 2: Parse dashboard_html from SSE tool_result**

In `frontend/src/agent/agentService.ts`, in the `tool_result` case handler (around line 225-237), add parsing for dashboard fields:

```typescript
dashboard_html: (data.dashboard_html as string) ?? undefined,
dashboard_title: (data.dashboard_title as string) ?? undefined,
```

Add these lines inside the `result` object construction, after the `chart_spec` parsing block.

**Step 3: Commit**

```bash
git add frontend/src/types.ts frontend/src/agent/agentService.ts frontend/src/contexts/AgentContext.tsx
git commit -m "feat: add dashboard_html type and SSE parsing to frontend"
```

---

### Task 5: Build HtmlDashboardWidget Component

**Files:**
- Create: `frontend/src/components/HtmlDashboardWidget.tsx`

**Step 1: Create the component**

Create `frontend/src/components/HtmlDashboardWidget.tsx`:

```tsx
import { useRef, useState, useEffect, useCallback } from 'react';

interface HtmlDashboardWidgetProps {
  html: string;
  title?: string;
}

export default function HtmlDashboardWidget({ html, title }: HtmlDashboardWidgetProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [iframeHeight, setIframeHeight] = useState(500);

  // Auto-resize iframe to fit content
  const handleLoad = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe?.contentDocument?.body) return;
    const contentHeight = iframe.contentDocument.body.scrollHeight;
    // Clamp between 400 and 900 pixels
    setIframeHeight(Math.min(Math.max(contentHeight, 400), 900));
  }, []);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    iframe.addEventListener('load', handleLoad);
    return () => iframe.removeEventListener('load', handleLoad);
  }, [handleLoad]);

  return (
    <div className={`html-dashboard-widget ${expanded ? 'html-dashboard-widget--expanded' : ''}`}>
      <div className="html-dashboard-widget__header">
        <span className="html-dashboard-widget__title">{title || 'Dashboard'}</span>
        <div className="html-dashboard-widget__actions">
          <button
            className="html-dashboard-widget__btn"
            onClick={() => setExpanded(!expanded)}
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? '⊖' : '⊕'}
          </button>
          <button
            className="html-dashboard-widget__btn"
            onClick={() => {
              const blob = new Blob([html], { type: 'text/html' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${(title || 'dashboard').replace(/\s+/g, '_').toLowerCase()}.html`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            title="Download HTML"
          >
            ⬇
          </button>
          <button
            className="html-dashboard-widget__btn"
            onClick={() => {
              const blob = new Blob([html], { type: 'text/html' });
              const url = URL.createObjectURL(blob);
              window.open(url, '_blank');
            }}
            title="Open in new tab"
          >
            ↗
          </button>
        </div>
      </div>
      <iframe
        ref={iframeRef}
        srcDoc={html}
        sandbox="allow-scripts"
        className="html-dashboard-widget__iframe"
        style={{ height: expanded ? '80vh' : `${iframeHeight}px` }}
        title={title || 'Dashboard'}
      />
    </div>
  );
}
```

**Step 2: Add styles**

Add to the project's CSS (in the component file or a shared stylesheet):

```css
.html-dashboard-widget {
  border: 1px solid var(--border-primary);
  border-radius: 8px;
  overflow: hidden;
  margin: 8px 0;
}

.html-dashboard-widget--expanded {
  position: fixed;
  inset: 16px;
  z-index: 1000;
  background: var(--bg-primary);
}

.html-dashboard-widget__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-primary);
}

.html-dashboard-widget__title {
  font-weight: 600;
  font-size: 0.875rem;
}

.html-dashboard-widget__actions {
  display: flex;
  gap: 4px;
}

.html-dashboard-widget__btn {
  background: none;
  border: 1px solid var(--border-primary);
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 0.875rem;
  color: var(--text-primary);
}

.html-dashboard-widget__btn:hover {
  background: var(--bg-tertiary);
}

.html-dashboard-widget__iframe {
  width: 100%;
  border: none;
  background: white;
}
```

**Step 3: Commit**

```bash
git add frontend/src/components/HtmlDashboardWidget.tsx
git commit -m "feat: add HtmlDashboardWidget component with sandboxed iframe"
```

---

### Task 6: Render Dashboard in MessageBubble

**Files:**
- Modify: `frontend/src/components/MessageBubble.tsx`

**Step 1: Import the widget**

At the top of `MessageBubble.tsx`, add:

```typescript
import HtmlDashboardWidget from './HtmlDashboardWidget';
```

**Step 2: Add dashboard detection**

In the chart/segment detection logic (around line 286), add dashboard detection:

```typescript
const hasDashboards = hasSegments && message.segments!.some(
  (s) => s.type === 'tool' && s.toolResult?.dashboard_html
);
```

**Step 3: Add dashboard rendering in the segment loop**

In the segment rendering loop (around line 412-424 where charts are rendered), add a condition for dashboards. After the chart rendering block:

```tsx
if (seg.type === 'tool' && seg.toolResult?.dashboard_html) {
  return (
    <div key={`dashboard-${i}`} className="message-bubble__chart-in-answer">
      <HtmlDashboardWidget
        html={seg.toolResult.dashboard_html}
        title={seg.toolResult.dashboard_title}
      />
    </div>
  );
}
```

**Step 4: Commit**

```bash
git add frontend/src/components/MessageBubble.tsx
git commit -m "feat: render inline dashboards in MessageBubble"
```

---

### Task 7: Add `render_dashboard` to System Prompt

**Files:**
- Modify: `backend/app/agent.py`

The agent needs to know about `render_dashboard` so it uses this tool instead of `Write` for dashboard output.

**Step 1: Add tool instruction to system prompt**

In `backend/app/agent.py`, in the `build_system_prompt()` function, add an instruction about the render_dashboard tool. Find where `render_chart` is mentioned in the system prompt (or the tool instructions section) and add:

```python
DASHBOARD_TOOL_INSTRUCTION = """
When building HTML dashboards (e.g. via /data:build-dashboard), use the `render_dashboard` MCP tool to display the dashboard inline in the chat instead of writing HTML files to disk. Pass the complete self-contained HTML string and a title. The dashboard will render in a sandboxed iframe in the UI. Users can also expand it fullscreen or download the HTML file.
"""
```

Add this to the system prompt string concatenation.

**Step 2: Commit**

```bash
git add backend/app/agent.py
git commit -m "feat: add render_dashboard instruction to system prompt"
```

---

### Task 8: Update README with Dashboard Caveat

**Files:**
- Modify: `README.md`

**Step 1: Add caveat to Plugins section**

In `README.md`, find the Plugins section (around line 70-76) and update the `build-dashboard` bullet to note the inline rendering requirement:

```markdown
### Plugins

- **Data analysis plugin** — The [knowledge-work-plugins/data](https://github.com/anthropics/knowledge-work-plugins/tree/main/data) plugin is bundled at `plugins/data/`, providing specialized commands and skills for data work
- **Plugin commands** — Invoke via slash commands: `/data:analyze`, `/data:explore-data`, `/data:write-query`, `/data:create-viz`, `/data:build-dashboard`, `/data:validate`
- **Plugin skills** — The plugin adds skills for SQL queries, data exploration, data visualization, statistical analysis, data validation, interactive dashboard building, and data context extraction
- **Inline dashboard rendering** — The `/data:build-dashboard` command renders interactive HTML dashboards (Chart.js) directly in the chat via a sandboxed iframe; dashboards can be expanded fullscreen or downloaded as standalone HTML files; this requires the `render_dashboard` MCP tool which is not part of the upstream plugin — it is a project-specific integration
- **Plugin isolation** — Plugins are bind-mounted read-only into sidecar containers at `/app/plugins/`; the plugin's external MCP server connections (Snowflake, Databricks, etc.) are neutralized since the agent uses its own DuckDB MCP server
```

**Step 2: Update Architecture Diagram**

In the MCP SSE Server section of the architecture diagram, add `render_dashboard` alongside the existing tools:

```
│  │  ┌────────────┐ ┌────────────┐ ┌──────────────────┐  │
│  │  │execute_sql │ │render_chart│ │render_dashboard  │  │
│  │  └────────────┘ └────────────┘ └──────────────────┘  │
```

And in the Data Flow section, add:

```
│     ├── render_dashboard → HTML string → sandboxed iframe
```

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add inline dashboard rendering caveat to README"
```

---

### Task 9: Rebuild Docker Images and Manual Verification

**Step 1: Rebuild sidecar and app images**

Run:
```bash
make compose-build
```

Expected: Both images rebuild successfully with the new code.

**Step 2: Start the app**

Run:
```bash
make compose-up
```

**Step 3: Manual test**

1. Open http://localhost:10000
2. Upload a CSV file with some data (or load the sample Titanic dataset)
3. Type: `/data:build-dashboard Create a simple dashboard showing passenger survival rates by class and gender`
4. Verify:
   - The agent calls `render_dashboard` (visible in the tool call segment)
   - An iframe appears inline in the chat with the rendered dashboard
   - Chart.js charts render correctly inside the iframe
   - The expand button makes the dashboard fullscreen
   - The download button saves a working HTML file
   - The "open in new tab" button opens the dashboard in a new browser tab

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: address issues found during manual dashboard testing"
```

---

## Summary of Changes

| File | Change |
|------|--------|
| `backend/app/mcp_sse.py` | Add `render_dashboard` tool definition and handler |
| `backend/app/agent.py` | Capture dashboard HTML, attach to SSE events, add system prompt instruction |
| `sidecar/src/server.ts` | Add `render_dashboard` to `allowedTools` |
| `frontend/src/types.ts` | Add `dashboard_html` and `dashboard_title` to `ToolCallResult` |
| `frontend/src/agent/agentService.ts` | Parse `dashboard_html` from SSE events |
| `frontend/src/components/HtmlDashboardWidget.tsx` | New sandboxed iframe widget with expand/download/open actions |
| `frontend/src/components/MessageBubble.tsx` | Render `HtmlDashboardWidget` for dashboard tool results |
| `README.md` | Add inline dashboard rendering caveat and update architecture diagram |

## Security Notes

- The iframe uses `sandbox="allow-scripts"` — this allows JavaScript execution (needed for Chart.js) but **blocks** same-origin access, form submission, popups, and navigation. The dashboard cannot access the parent page's DOM, cookies, or localStorage.
- Dashboard HTML is passed as a string through the MCP protocol, not served from a URL. This avoids adding any new attack surface for file serving.
- The `srcdoc` attribute avoids network-based content loading from the sidecar's ephemeral filesystem.
