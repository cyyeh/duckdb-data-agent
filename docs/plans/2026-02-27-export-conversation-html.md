# Export Conversation as Static HTML — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an Export button that downloads the conversation as a self-contained HTML file with full interactivity (collapsible thinking, interactive Plotly charts).

**Architecture:** Clone the live `.agent-panel__messages` DOM, embed the app's CSS stylesheets, replace Plotly chart divs with data-attribute placeholders, and include a Plotly CDN script that re-initializes charts on load. The export logic lives in a standalone utility function.

**Tech Stack:** TypeScript, DOM APIs (`cloneNode`, `document.styleSheets`), Plotly CDN, Blob/URL.createObjectURL for download trigger.

---

### Task 1: Add i18n keys

**Files:**
- Modify: `frontend/src/i18n/en.json`
- Modify: `frontend/src/i18n/zh-TW.json`

**Step 1: Add the `export` key to en.json**

In `frontend/src/i18n/en.json`, add after the `"clear"` line:

```json
"export": "Export",
```

**Step 2: Add the `export` key to zh-TW.json**

In `frontend/src/i18n/zh-TW.json`, add after the `"clear"` line:

```json
"export": "匯出",
```

**Step 3: Commit**

```bash
git add frontend/src/i18n/en.json frontend/src/i18n/zh-TW.json
git commit -m "feat: add i18n keys for export button"
```

---

### Task 2: Create the export utility

**Files:**
- Create: `frontend/src/utils/exportConversation.ts`

**Step 1: Write the export utility**

Create `frontend/src/utils/exportConversation.ts` with this content:

```typescript
/**
 * Export the conversation panel as a self-contained HTML file.
 *
 * Strategy:
 * 1. Clone the .agent-panel__messages DOM
 * 2. Extract Plotly chart data before cloning (react-plotly stores .data/.layout on the el)
 * 3. Remove interactive-only elements (edit/delete buttons, retry, streaming indicators)
 * 4. Gather CSS from document.styleSheets
 * 5. Build a standalone HTML document with embedded CSS + Plotly CDN
 * 6. Trigger browser download
 */

interface PlotlyChartData {
  data: unknown[];
  layout: Record<string, unknown>;
  frames?: unknown[];
}

function extractPlotlyCharts(container: HTMLElement): PlotlyChartData[] {
  const charts: PlotlyChartData[] = [];
  // react-plotly.js renders into .js-plotly-plot elements
  const plotEls = container.querySelectorAll('.js-plotly-plot');
  plotEls.forEach((el) => {
    const plotEl = el as HTMLElement & { data?: unknown[]; layout?: Record<string, unknown>; _transitionData?: { _frames?: unknown[] } };
    if (plotEl.data && plotEl.layout) {
      charts.push({
        data: JSON.parse(JSON.stringify(plotEl.data)),
        layout: JSON.parse(JSON.stringify(plotEl.layout)),
        frames: plotEl._transitionData?._frames
          ? JSON.parse(JSON.stringify(plotEl._transitionData._frames))
          : undefined,
      });
    }
  });
  return charts;
}

function gatherCSS(): string {
  const rules: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        rules.push(rule.cssText);
      }
    } catch {
      // Cross-origin stylesheets will throw — skip them
    }
  }
  return rules.join('\n');
}

function cleanClone(clone: HTMLElement): void {
  // Remove edit/delete action buttons
  clone.querySelectorAll('.message-bubble__actions').forEach((el) => el.remove());
  // Remove delete confirmation dialogs
  clone.querySelectorAll('.message-bubble__confirm-delete').forEach((el) => el.remove());
  // Remove edit mode textareas
  clone.querySelectorAll('.message-bubble__edit-mode').forEach((el) => el.remove());
  // Remove error retry buttons
  clone.querySelectorAll('.message-bubble__error-retry').forEach((el) => el.remove());
  // Remove streaming indicators
  clone.querySelectorAll('.message-bubble__typing').forEach((el) => el.remove());
}

function replacePlotlyWithPlaceholders(clone: HTMLElement): void {
  const plotEls = clone.querySelectorAll('.js-plotly-plot');
  plotEls.forEach((el, i) => {
    const placeholder = document.createElement('div');
    placeholder.setAttribute('data-plotly-chart', String(i));
    placeholder.style.width = '100%';
    placeholder.style.minHeight = '400px';
    el.parentElement?.replaceChild(placeholder, el);
  });
}

export function exportConversation(): void {
  const messagesContainer = document.querySelector('.agent-panel__messages');
  if (!messagesContainer) return;

  // 1. Extract Plotly data from live DOM before cloning
  const charts = extractPlotlyCharts(messagesContainer as HTMLElement);

  // 2. Clone the DOM
  const clone = messagesContainer.cloneNode(true) as HTMLElement;

  // 3. Clean up interactive-only elements
  cleanClone(clone);

  // 4. Replace Plotly chart elements with placeholders
  replacePlotlyWithPlaceholders(clone);

  // 5. Gather CSS
  const css = gatherCSS();

  // 6. Get current theme
  const theme = document.documentElement.getAttribute('data-theme') || 'light';

  // 7. Get the header title text
  const titleEl = document.querySelector('.agent-panel__title');
  const title = titleEl?.textContent || 'Agent Mode';

  // 8. Build the HTML document
  const html = buildHTML({ clone, css, charts, theme, title });

  // 9. Trigger download
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `conversation-${date}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function buildHTML(opts: {
  clone: HTMLElement;
  css: string;
  charts: PlotlyChartData[];
  theme: string;
  title: string;
}): string {
  const { clone, css, charts, theme, title } = opts;

  const chartsJSON = JSON.stringify(charts);

  return `<!DOCTYPE html>
<html data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DuckDB Data Agent — Conversation Export</title>
${charts.length > 0 ? '<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"><\/script>' : ''}
<style>
${css}

/* Export-specific overrides */
body {
  max-width: 900px;
  margin: 0 auto;
  padding: 20px;
}
.agent-panel__messages {
  overflow: visible;
  padding: 0;
}
</style>
</head>
<body>
<div class="agent-panel">
  <div class="agent-panel__header">
    <span class="agent-panel__title">${escapeHTML(title)}</span>
  </div>
  ${clone.outerHTML}
</div>
${charts.length > 0 ? `<script>
(function() {
  var charts = ${chartsJSON};
  document.querySelectorAll('[data-plotly-chart]').forEach(function(el) {
    var idx = parseInt(el.getAttribute('data-plotly-chart'), 10);
    var chart = charts[idx];
    if (chart && window.Plotly) {
      Plotly.newPlot(el, chart.data, Object.assign({ autosize: true, height: 400 }, chart.layout), { responsive: true, displayModeBar: true });
    }
  });
})();
<\/script>` : ''}
</body>
</html>`;
}

function escapeHTML(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
```

**Step 2: Verify TypeScript compilation**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add frontend/src/utils/exportConversation.ts
git commit -m "feat: add exportConversation utility for static HTML export"
```

---

### Task 3: Add the Export button to AgentPanel

**Files:**
- Modify: `frontend/src/components/AgentPanel.tsx`

**Step 1: Add the import and button**

In `AgentPanel.tsx`, add the import at the top (after the existing imports):

```typescript
import { exportConversation } from '../utils/exportConversation';
```

Then in the JSX, add the export button right after the clear button inside `.agent-panel__actions`:

```tsx
{messages.length > 0 && (
  <button className="agent-panel__clear" onClick={() => exportConversation()}>
    {t('export')}
  </button>
)}
```

The full `agent-panel__actions` div should look like:

```tsx
<div className="agent-panel__actions">
  {messages.length > 0 && (
    <button className="agent-panel__clear" onClick={() => exportConversation()}>
      {t('export')}
    </button>
  )}
  {messages.length > 0 && (
    <button className="agent-panel__clear" onClick={() => { if (confirm(t('clearConfirm'))) clearMessages(); }}>
      {t('clear')}
    </button>
  )}
</div>
```

**Step 2: Verify TypeScript compilation**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add frontend/src/components/AgentPanel.tsx
git commit -m "feat: add Export button to agent panel header"
```

---

### Task 4: Manual integration test

**Files:** None (testing only)

**Step 1: Start the dev server**

Run: `cd frontend && npm run dev`

**Step 2: Verify button appears**

1. Upload a file or load sample data
2. Send a message to the agent so messages appear
3. Verify the "Export" button appears next to "Clear Chat History"
4. Verify button styling matches the clear button

**Step 3: Test the export**

1. Have a conversation with at least:
   - A user message
   - An assistant response with a thinking block
   - A tool call with SQL results
   - If possible, a chart
2. Click "Export"
3. Verify a file `conversation-YYYY-MM-DD.html` is downloaded
4. Open the file in a browser
5. Verify:
   - Theme matches (dark/light)
   - Thinking blocks are collapsible (click the triangle)
   - SQL query result tables display correctly
   - Charts are interactive (if any) — zoom, hover tooltips work
   - No edit/delete buttons appear
   - No retry buttons appear
   - No streaming indicators appear
   - Layout looks reasonable (centered, max-width 900px)

**Step 4: Test edge cases**

1. Export during a streaming response — verify partial content exports fine
2. Export with dark theme, then switch to light and export again — verify each matches
3. Export a conversation with no charts — verify no Plotly script tag in HTML

**Step 5: Final commit if any fixes needed**

Only commit if changes were made during testing.
