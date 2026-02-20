import { useTranslation } from '../LanguageContext';
import type { ToolCallResult } from '../types';
import './InlineQueryResult.css';

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
    if (entries.length === 1) return String(entries[0][1]);
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
