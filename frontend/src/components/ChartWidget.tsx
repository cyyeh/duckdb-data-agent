import Plot from 'react-plotly.js';

interface ChartWidgetProps {
  data: unknown[];
  layout?: Record<string, unknown>;
  frames?: unknown[];
}

export function ChartWidget({ data, layout, frames }: ChartWidgetProps) {
  // Normalize layout.title: Plotly v3 requires {text: "..."} object form
  const normalizedLayout = { ...layout };
  if (typeof normalizedLayout.title === 'string') {
    normalizedLayout.title = { text: normalizedLayout.title };
  }

  // frames can live at the top level or inside layout (common variant);
  // extract from layout so Plotly receives them as a dedicated prop.
  const resolvedFrames = frames || (normalizedLayout.frames as unknown[]);
  delete normalizedLayout.frames;

  return (
    <Plot
      data={data as Plotly.Data[]}
      layout={{ autosize: true, height: 400, ...normalizedLayout } as Partial<Plotly.Layout>}
      frames={resolvedFrames as Plotly.Frame[] | undefined}
      useResizeHandler
      style={{ width: '100%' }}
      config={{ responsive: true, displayModeBar: true }}
    />
  );
}
