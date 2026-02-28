import { useState, useCallback } from 'react';
import { useTranslation } from '../hooks/useTranslation';
import type { ToolCallResult } from '../types';
import './InlineQueryResult.css';
import { ChartWidget } from './ChartWidget';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // fallback
    }
  }, [text]);

  return (
    <button
      className="inline-query__copy-btn"
      onClick={handleCopy}
      title={copied ? 'Copied!' : 'Copy'}
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

const MAX_DISPLAY_ROWS = 20;

function getToolDisplayName(result: ToolCallResult, t: (key: string) => string): string {
  const name = result.toolName || '';
  if (name.includes('execute_sql')) return t('sqlQuery');
  if (name === 'Bash') return t('bash');
  if (name === 'Read') return t('readFile');
  if (name === 'Write') return t('writeFile');
  if (name === 'Edit') return t('editFile');
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    return parts[parts.length - 1] || name;
  }
  return name || 'Tool';
}

function getToolInputDisplay(result: ToolCallResult): string | null {
  if (result.sql) return result.sql;
  if (result.command) return result.command;
  if (result.toolInput) {
    const entries = Object.entries(result.toolInput);
    if (entries.length === 0) return null;
    // For single-value inputs, show just the value
    if (entries.length === 1) {
      const val = entries[0][1];
      if (val === null || val === undefined) return '';
      if (typeof val === 'object') return JSON.stringify(val, null, 2);
      return String(val);
    }
    return JSON.stringify(result.toolInput, null, 2);
  }
  return null;
}

function isSQL(result: ToolCallResult): boolean {
  return !!result.sql && (result.toolName?.includes('execute_sql') ?? false);
}

export function InlineQueryResult({ result }: { result: ToolCallResult }) {
  const { t } = useTranslation();
  const displayName = getToolDisplayName(result, t);
  const inputDisplay = getToolInputDisplay(result);
  const isSQLTool = isSQL(result);
  const hasStructuredData = result.columns.length > 0;
  const displayRows = result.rows.slice(0, MAX_DISPLAY_ROWS);

  // Render chart if chart_spec is present
  if (result.chart_spec) {
    return (
      <div className="inline-query inline-query--chart">
        <div className="inline-query__label inline-query__label--generic">
          {(result.chart_spec?.layout?.title as string) || getToolDisplayName(result, t)}
          <CopyButton text={JSON.stringify(result.chart_spec, null, 2)} />
        </div>
        <ChartWidget
          data={result.chart_spec.data}
          layout={result.chart_spec.layout}
          frames={result.chart_spec.frames}
        />
      </div>
    );
  }

  // Determine border color class
  let variantClass = '';
  if (result.error) variantClass = 'inline-query--error';
  else if (result.command) variantClass = 'inline-query--bash';
  else if (!isSQLTool && !result.sql) variantClass = 'inline-query--generic';

  return (
    <div className={`inline-query ${variantClass}`}>
      {/* Tool label */}
      <div className={`inline-query__label ${isSQLTool ? 'inline-query__label--sql' : result.command ? 'inline-query__label--bash' : 'inline-query__label--generic'}`}>
        {displayName}
      </div>

      {/* Tool input */}
      {inputDisplay && (
        <div className="inline-query__sql">
          <CopyButton text={inputDisplay} />
          <code>{inputDisplay}</code>
        </div>
      )}

      {/* Error display */}
      {result.error && (
        <div className="inline-query__error">{result.error}</div>
      )}

      {/* SQL structured results */}
      {!result.error && isSQLTool && hasStructuredData && (
        <>
          <div className="inline-query__table-wrapper">
            <table className="inline-query__table">
              <thead>
                <tr>
                  {result.columns.map((col) => (
                    <th key={col}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayRows.map((row, i) => (
                  <tr key={i}>
                    {result.columns.map((col) => (
                      <td key={col}>{String(row[col] ?? '')}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="inline-query__meta">
            {t('rowCount', { count: result.rowCount })}
            {result.rowCount > MAX_DISPLAY_ROWS && ` ${t('showingCount', { count: MAX_DISPLAY_ROWS })}`}
          </div>
        </>
      )}

      {/* Text output for non-SQL tools */}
      {!result.error && result.output && (
        <div className="inline-query__output">
          <pre>{result.output}</pre>
        </div>
      )}

      {/* Raw content fallback */}
      {!result.error && !hasStructuredData && !result.output && result.rawContent && (
        <div className="inline-query__raw">
          <pre>{result.rawContent}</pre>
        </div>
      )}

      {/* Pending state */}
      {!result.error && !hasStructuredData && !result.output && !result.rawContent && inputDisplay && (
        <div className="inline-query__meta">{t('executing')}</div>
      )}
    </div>
  );
}
