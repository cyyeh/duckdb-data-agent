import Plot from 'react-plotly.js';
import { useTheme } from '../hooks/useTheme';

interface ChartWidgetProps {
  data: unknown[];
  layout?: Record<string, unknown>;
  frames?: unknown[];
}

export function ChartWidget({ data, layout, frames }: ChartWidgetProps) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  // Normalize layout.title: Plotly v3 requires {text: "..."} object form
  const normalizedLayout = { ...layout };
  if (typeof normalizedLayout.title === 'string') {
    normalizedLayout.title = { text: normalizedLayout.title };
  }

  // frames can live at the top level or inside layout (common variant);
  // extract from layout so Plotly receives them as a dedicated prop.
  const resolvedFrames = frames || (normalizedLayout.frames as unknown[]);
  delete normalizedLayout.frames;

  // Theme-aware colors for Plotly
  const themeLayout = isDark
    ? {
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        font: { color: '#e2e8f0' },
        xaxis: { gridcolor: '#374151', zerolinecolor: '#374151' },
        yaxis: { gridcolor: '#374151', zerolinecolor: '#374151' },
        legend: { font: { color: '#e2e8f0' } },
      }
    : {
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
      };

  return (
    <Plot
      data={data as Plotly.Data[]}
      layout={{ autosize: true, height: 400, ...themeLayout, ...normalizedLayout } as Partial<Plotly.Layout>}
      frames={resolvedFrames as Plotly.Frame[] | undefined}
      useResizeHandler
      style={{ width: '100%' }}
      config={{ responsive: true, displayModeBar: true }}
    />
  );
}
