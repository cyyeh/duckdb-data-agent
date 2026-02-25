import Plotly from 'plotly.js-dist-min';
import { useCallback, useRef } from 'react';
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

  // frames can live at the top level or inside layout (common variant)
  const resolvedFrames = frames || (normalizedLayout.frames as unknown[]) || [];
  delete normalizedLayout.frames;

  const framesAdded = useRef(false);

  // react-plotly.js v2.6 doesn't properly register frames with Plotly.js v3.
  // Manually add frames via Plotly.addFrames() after the plot initializes.
  const handleInitialized = useCallback(
    (_figure: unknown, graphDiv: HTMLElement) => {
      if (resolvedFrames.length && !framesAdded.current) {
        framesAdded.current = true;
        Plotly.addFrames(graphDiv, resolvedFrames as Plotly.Frame[]);
      }
    },
    [resolvedFrames],
  );

  return (
    <Plot
      data={data as Plotly.Data[]}
      layout={{ autosize: true, height: 400, ...normalizedLayout } as Partial<Plotly.Layout>}
      useResizeHandler
      style={{ width: '100%' }}
      config={{ responsive: true, displayModeBar: true }}
      onInitialized={handleInitialized}
    />
  );
}
