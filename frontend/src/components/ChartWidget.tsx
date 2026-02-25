import Plot from 'react-plotly.js';

interface ChartWidgetProps {
  data: unknown[];
  layout?: Record<string, unknown>;
}

export function ChartWidget({ data, layout }: ChartWidgetProps) {
  // Normalize layout.title: Plotly v3 requires {text: "..."} object form
  const normalizedLayout = { ...layout };
  if (typeof normalizedLayout.title === 'string') {
    normalizedLayout.title = { text: normalizedLayout.title };
  }

  return (
    <Plot
      data={data as Plotly.Data[]}
      layout={{ autosize: true, height: 400, ...normalizedLayout } as Partial<Plotly.Layout>}
      useResizeHandler
      style={{ width: '100%' }}
      config={{ responsive: true, displayModeBar: true }}
    />
  );
}
