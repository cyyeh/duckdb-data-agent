import Plot from 'react-plotly.js';
import { useTheme } from '../hooks/useTheme';
import { useTranslation } from '../hooks/useTranslation';

interface ChartWidgetProps {
  data: unknown[];
  layout?: Record<string, unknown>;
  frames?: unknown[];
}

export function ChartWidget({ data, layout, frames }: ChartWidgetProps) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const { t } = useTranslation();

  // Guard: don't render a blank Plotly chart when all traces have empty data
  const DATA_FIELDS = ['x', 'y', 'z', 'values', 'labels', 'lat', 'lon', 'r', 'theta',
    'lowerfence', 'q1', 'median', 'q3', 'upperfence'];
  const hasData = Array.isArray(data) && data.some((trace) => {
    if (!trace || typeof trace !== 'object') return false;
    const t = trace as Record<string, unknown>;
    return DATA_FIELDS.some((f) => Array.isArray(t[f]) && (t[f] as unknown[]).length > 0);
  });
  if (!hasData) {
    return (
      <div style={{ padding: '1rem', textAlign: 'center', opacity: 0.6 }}>
        {t('chartNoData')}
      </div>
    );
  }

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
