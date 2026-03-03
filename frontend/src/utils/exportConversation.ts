/**
 * Export the conversation panel as a self-contained HTML file.
 *
 * Strategy:
 * 1. Clone the .agent-panel__messages DOM
 * 2. Extract Plotly chart data before cloning (react-plotly stores .data/.layout on the el)
 * 3. Extract Vega-Lite specs from data attributes before cloning
 * 4. Remove interactive-only elements (edit/delete buttons, retry, streaming indicators)
 * 5. Gather CSS from document.styleSheets
 * 6. Build a standalone HTML document with embedded CSS + chart CDN scripts
 * 7. Trigger browser download
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

function extractVegaLiteCharts(container: HTMLElement): Record<string, unknown>[] {
  const specs: Record<string, unknown>[] = [];
  const vegaEls = container.querySelectorAll('.vega-lite-chart[data-vegalite-spec]');
  vegaEls.forEach((el) => {
    const raw = el.getAttribute('data-vegalite-spec');
    if (raw) {
      try {
        specs.push(JSON.parse(raw));
      } catch {
        // Skip malformed specs
      }
    }
  });
  return specs;
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
  // Strip javascript: hrefs from user-supplied markdown links
  clone.querySelectorAll('a[href^="javascript:"]').forEach((el) => el.removeAttribute('href'));
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

function replaceVegaLiteWithPlaceholders(clone: HTMLElement): void {
  const vegaEls = clone.querySelectorAll('.vega-lite-chart[data-vegalite-spec]');
  vegaEls.forEach((el, i) => {
    const placeholder = document.createElement('div');
    placeholder.setAttribute('data-vegalite-chart', String(i));
    placeholder.style.width = '100%';
    placeholder.style.minHeight = '400px';
    el.parentElement?.replaceChild(placeholder, el);
  });
}

export function exportConversation(): void {
  const messagesContainer = document.querySelector('.agent-panel__messages');
  if (!messagesContainer) return;

  // 1. Extract chart data from live DOM before cloning
  const plotlyCharts = extractPlotlyCharts(messagesContainer as HTMLElement);
  const vegaLiteCharts = extractVegaLiteCharts(messagesContainer as HTMLElement);

  // 2. Clone the DOM
  const clone = messagesContainer.cloneNode(true) as HTMLElement;

  // 3. Clean up interactive-only elements
  cleanClone(clone);

  // 4. Replace chart elements with placeholders
  replacePlotlyWithPlaceholders(clone);
  replaceVegaLiteWithPlaceholders(clone);

  // 5. Gather CSS
  const css = gatherCSS();

  // 6. Get current theme
  const theme = document.documentElement.getAttribute('data-theme') || 'light';

  // 7. Get the header title text
  const titleEl = document.querySelector('.agent-panel__title');
  const title = titleEl?.textContent || 'Agent Mode';

  // 8. Build the HTML document
  const html = buildHTML({ clone, css, plotlyCharts, vegaLiteCharts, theme, title });

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
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

function buildHTML(opts: {
  clone: HTMLElement;
  css: string;
  plotlyCharts: PlotlyChartData[];
  vegaLiteCharts: Record<string, unknown>[];
  theme: string;
  title: string;
}): string {
  const { clone, css, plotlyCharts, vegaLiteCharts, theme, title } = opts;

  const hasPlotly = plotlyCharts.length > 0;
  const hasVegaLite = vegaLiteCharts.length > 0;

  const plotlyChartsJSON = JSON.stringify(plotlyCharts).replace(/<\//g, '<\\/');
  const vegaLiteChartsJSON = JSON.stringify(vegaLiteCharts).replace(/<\//g, '<\\/');

  return `<!DOCTYPE html>
<html data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DuckDB Data Agent — Conversation Export</title>
${hasPlotly ? '<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"><\/script>' : ''}
${hasVegaLite ? `<script src="https://cdn.jsdelivr.net/npm/vega@5"><\/script>
<script src="https://cdn.jsdelivr.net/npm/vega-lite@5"><\/script>
<script src="https://cdn.jsdelivr.net/npm/vega-embed@6"><\/script>
<script src="https://cdn.jsdelivr.net/npm/vega-themes"><\/script>` : ''}
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
${hasPlotly ? `<script>
(function() {
  var charts = ${plotlyChartsJSON};
  document.querySelectorAll('[data-plotly-chart]').forEach(function(el) {
    var idx = parseInt(el.getAttribute('data-plotly-chart'), 10);
    var chart = charts[idx];
    if (chart && window.Plotly) {
      Plotly.newPlot(el, chart.data, Object.assign({ autosize: true, height: 400 }, chart.layout), { responsive: true, displayModeBar: true });
    }
  });
})();
<\/script>` : ''}
${hasVegaLite ? `<script>
(function() {
  var specs = ${vegaLiteChartsJSON};
  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  var pbiTheme = window.vegaThemes ? window.vegaThemes.powerbi : {};
  var darkOverrides = {
    background: 'transparent',
    axis: { labelColor: '#e2e8f0', titleColor: '#e2e8f0', gridColor: '#374151', domainColor: '#4b5563' },
    legend: { labelColor: '#e2e8f0', titleColor: '#e2e8f0' },
    title: { color: '#e2e8f0' },
    view: { stroke: 'transparent' }
  };
  var config = isDark
    ? Object.assign({}, pbiTheme, darkOverrides, {
        axis: Object.assign({}, pbiTheme.axis, darkOverrides.axis),
        legend: Object.assign({}, pbiTheme.legend, darkOverrides.legend),
        title: Object.assign({}, pbiTheme.title, darkOverrides.title)
      })
    : Object.assign({}, pbiTheme, { background: 'transparent', view: { stroke: 'transparent' } });
  document.querySelectorAll('[data-vegalite-chart]').forEach(function(el) {
    var idx = parseInt(el.getAttribute('data-vegalite-chart'), 10);
    var spec = specs[idx];
    if (spec && window.vegaEmbed) {
      var fullSpec = Object.assign({}, spec, {
        width: 'container',
        autosize: { type: 'fit', contains: 'padding' },
        config: config
      });
      vegaEmbed(el, fullSpec, { actions: true, renderer: 'svg' });
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
