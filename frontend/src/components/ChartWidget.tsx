import createPlotlyComponent from 'react-plotly.js/factory';
import Plotly from 'plotly.js-dist-min';

const Plot = createPlotlyComponent(Plotly);

interface ChartWidgetProps {
  data: unknown[];
  layout?: Record<string, unknown>;
}

export function ChartWidget({ data, layout }: ChartWidgetProps) {
  return (
    <Plot
      data={data as Plotly.Data[]}
      layout={{ autosize: true, ...layout } as Partial<Plotly.Layout>}
      useResizeHandler
      style={{ width: '100%' }}
      config={{ responsive: true, displayModeBar: true }}
    />
  );
}
