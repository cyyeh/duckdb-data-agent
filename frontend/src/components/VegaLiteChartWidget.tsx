import { useEffect, useRef, useState } from 'react';
import embed from 'vega-embed';
import { useTheme } from '../hooks/useTheme';
import { useTranslation } from '../hooks/useTranslation';

interface VegaLiteChartWidgetProps {
  spec: Record<string, unknown>;
}

export function VegaLiteChartWidget({ spec }: VegaLiteChartWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current || !spec) return;

    const darkConfig = {
      background: 'transparent',
      axis: {
        labelColor: '#e2e8f0',
        titleColor: '#e2e8f0',
        gridColor: '#374151',
        domainColor: '#374151',
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

    const lightConfig = {
      background: 'transparent',
      view: {
        stroke: 'transparent',
      },
    };

    const fullSpec = {
      ...spec,
      width: 'container',
      autosize: { type: 'fit', contains: 'padding' },
      config: isDark ? darkConfig : lightConfig,
    };

    let disposed = false;
    embed(containerRef.current, fullSpec as never, {
      actions: true,
      renderer: 'svg',
    })
      .then((result) => {
        if (disposed) {
          result.finalize();
        }
      })
      .catch((err) => {
        if (!disposed) {
          setError(err?.message || 'Failed to render Vega-Lite chart');
        }
      });

    return () => {
      disposed = true;
    };
  }, [spec, isDark]);

  if (error) {
    return (
      <div style={{ padding: '1rem', textAlign: 'center', opacity: 0.6 }}>
        {t('chartRenderError')}: {error}
      </div>
    );
  }

  return <div ref={containerRef} style={{ width: '100%', minHeight: 400 }} />;
}
