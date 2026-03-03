import { useEffect, useRef, useState } from 'react';
import embed from 'vega-embed';
import { powerbi as powerbiTheme } from 'vega-themes';
import { useTheme } from '../hooks/useTheme';
import { useTranslation } from '../hooks/useTranslation';

// Dark mode overrides on top of the Power BI theme
const darkOverrides = {
  background: 'transparent',
  axis: {
    labelColor: '#e2e8f0',
    titleColor: '#e2e8f0',
    gridColor: '#374151',
    domainColor: '#4b5563',
  },
  legend: {
    labelColor: '#e2e8f0',
    titleColor: '#e2e8f0',
  },
  title: {
    color: '#e2e8f0',
  },
  view: {
    stroke: 'transparent',
  },
};

interface VegaLiteChartWidgetProps {
  spec: Record<string, unknown>;
}

export function VegaLiteChartWidget({ spec }: VegaLiteChartWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<{ finalize: () => void } | null>(null);
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current || !spec) return;

    setError(null);
    viewRef.current?.finalize();
    viewRef.current = null;

    const config = isDark
      ? { ...powerbiTheme, ...darkOverrides, axis: { ...powerbiTheme.axis, ...darkOverrides.axis }, legend: { ...powerbiTheme.legend, ...darkOverrides.legend }, title: { ...powerbiTheme.title, ...darkOverrides.title } }
      : { ...powerbiTheme, background: 'transparent', view: { stroke: 'transparent' } };

    const fullSpec = {
      ...spec,
      width: 'container',
      autosize: { type: 'fit', contains: 'padding' },
      config,
    };

    let cancelled = false;
    embed(containerRef.current, fullSpec as never, {
      actions: true,
      renderer: 'svg',
    })
      .then((result) => {
        if (cancelled) {
          result.finalize();
        } else {
          viewRef.current = result;
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err?.message || 'Failed to render Vega-Lite chart');
        }
      });

    return () => {
      cancelled = true;
      viewRef.current?.finalize();
      viewRef.current = null;
    };
  }, [spec, isDark]);

  if (error) {
    return (
      <div style={{ padding: '1rem', textAlign: 'center', opacity: 0.6 }}>
        {t('chartRenderError')}: {error}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="vega-lite-chart"
      data-vegalite-spec={JSON.stringify(spec)}
      style={{ width: '100%', minHeight: 400 }}
    />
  );
}
