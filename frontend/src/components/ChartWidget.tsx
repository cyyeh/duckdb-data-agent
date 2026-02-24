import Plot from 'react-plotly.js';

interface ChartWidgetProps {
  data: unknown[];
  layout?: Record<string, unknown>;
}

export function ChartWidget({ data, layout }: ChartWidgetProps) {
  return (
    <Plot
      data={data as Plotly.Data[]}
      layout={{ autosize: true, height: 400, ...layout } as Partial<Plotly.Layout>}
      useResizeHandler
      style={{ width: '100%' }}
      config={{ responsive: true, displayModeBar: true }}
    />
  );
}
