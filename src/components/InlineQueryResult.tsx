import type { ToolCallResult } from '../types';
import './InlineQueryResult.css';

const MAX_DISPLAY_ROWS = 20;

export function InlineQueryResult({ result }: { result: ToolCallResult }) {
  if (result.error) {
    return (
      <div className="inline-query inline-query--error">
        <div className="inline-query__sql">
          <code>{result.sql}</code>
        </div>
        <div className="inline-query__error">{result.error}</div>
      </div>
    );
  }

  const displayRows = result.rows.slice(0, MAX_DISPLAY_ROWS);
  const hasStructuredData = result.columns.length > 0;

  return (
    <div className="inline-query">
      {result.sql && (
        <div className="inline-query__sql">
          <code>{result.sql}</code>
        </div>
      )}
      {hasStructuredData ? (
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
            {result.rowCount} row{result.rowCount !== 1 ? 's' : ''}
            {result.rowCount > MAX_DISPLAY_ROWS && ` (showing ${MAX_DISPLAY_ROWS})`}
          </div>
        </>
      ) : result.rawContent ? (
        <div className="inline-query__raw">
          <pre>{result.rawContent}</pre>
        </div>
      ) : result.sql ? (
        <div className="inline-query__meta">Executing...</div>
      ) : null}
    </div>
  );
}
