# Export Conversation as Static HTML

## Summary

Add an "Export" button next to the "Clear Chat History" button that downloads the full conversation as a single self-contained HTML file. The exported file preserves full interactivity: collapsible thinking blocks, interactive Plotly charts, and styled query result tables.

## Approach

**DOM Cloning + Inline CSS + Plotly CDN.** Clone the live `.agent-panel__messages` DOM, embed the app's CSS rules, and include a Plotly CDN script to re-initialize charts on load.

Alternatives considered:
- **Re-render from message data:** Cleaner output but duplicates MessageBubble rendering logic and increases maintenance burden.
- **Screenshot (html2canvas):** Simplest but produces a static image with no interactivity.

## Button Placement & UX

- Location: `.agent-panel__actions` div, to the right of the "Clear Chat History" button
- Visibility: Same condition as clear button (`messages.length > 0`)
- Styling: Matches `.agent-panel__clear` pattern (minimal bordered button)
- Label: "Export" (i18n keys: `export` in en.json, zh-TW.json)
- On click: Serializes conversation to HTML and triggers browser download as `conversation-YYYY-MM-DD.html`
- No loading spinner needed for typical conversations

## Exported HTML Structure

```html
<!DOCTYPE html>
<html data-theme="dark|light">
<head>
  <meta charset="utf-8">
  <title>DuckDB Data Agent — Conversation Export</title>
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
  <style>
    /* Embedded: index.css theme variables, AgentPanel.css, MessageBubble.css,
       InlineQueryResult.css, ChartWidget.css, UserQuestion.css */
  </style>
</head>
<body>
  <div class="agent-panel">
    <div class="agent-panel__header">
      <span class="agent-panel__title">Agent Mode</span>
    </div>
    <div class="agent-panel__messages">
      <!-- Cloned message bubble DOM -->
    </div>
  </div>
  <script>
    // Re-initialize Plotly charts from embedded data
  </script>
</body>
</html>
```

Key decisions:
- **Theme:** Uses whichever theme is active at export time
- **Plotly CDN:** Loads from CDN (~3MB on-demand) rather than inlining. Charts require internet to render.
- **CSS:** Extracted from `document.styleSheets` API (not per-element computed styles) for clean, small output
- **Scope:** Conversation panel only (no sidebar, no header bar)

## Plotly Chart Re-initialization

1. Before cloning: extract `data`, `layout`, `frames` from each Plotly chart div (react-plotly.js stores these on the element)
2. During cloning: replace chart divs with `<div data-plotly-chart="N">` placeholders
3. In export script: on `DOMContentLoaded`, iterate over `[data-plotly-chart]` elements and call `Plotly.newPlot(el, data, layout, config)` using the embedded JSON

## DOM Cleanup

**Remove from clone:**
- Edit/delete action buttons (`.message-bubble__actions`)
- Delete confirmation dialogs (`.message-bubble__confirm-delete`)
- Edit mode textareas (`.message-bubble__edit-mode`)
- Error retry buttons (`.message-bubble__error-retry`)
- Streaming indicators (`.message-bubble__typing`)

**Keep in clone:**
- `<details>` thinking blocks (native HTML collapsibility, no JS needed)
- Query result tables (static HTML)
- Plotly chart placeholders (re-initialized by script)
- User question blocks with answered state
- Error blocks (without retry button)

## Edge Cases

- Streaming in progress: export current state as-is (partial content)
- Empty conversations: export button is hidden, not reachable
- No charts: Plotly CDN script tag is still included but harmless

## File Organization

- Export logic: `frontend/src/utils/exportConversation.ts` (standalone utility)
- Button added in: `frontend/src/components/AgentPanel.tsx`
- i18n: add `export` key to `en.json` and `zh-TW.json`

## Query Result Tables

Rendered as static HTML tables in the export. No sorting or filtering - faithful to the current rendered state.
