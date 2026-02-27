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
