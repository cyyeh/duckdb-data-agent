import { useState, useCallback, type KeyboardEvent } from 'react';
import './QueryEditor.css';

interface QueryEditorProps {
  onExecute: (sql: string) => Promise<void>;
  initialQuery?: string;
}

export function QueryEditor({ onExecute, initialQuery }: QueryEditorProps) {
  const [sql, setSql] = useState(initialQuery ?? '');
  const [running, setRunning] = useState(false);

  // Update when parent changes initialQuery
  const [prevInitial, setPrevInitial] = useState(initialQuery);
  if (initialQuery !== prevInitial) {
    setPrevInitial(initialQuery);
    if (initialQuery !== undefined) setSql(initialQuery);
  }

  const run = useCallback(async () => {
    const trimmed = sql.trim();
    if (!trimmed || running) return;
    setRunning(true);
    try {
      await onExecute(trimmed);
    } finally {
      setRunning(false);
    }
  }, [sql, running, onExecute]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        run();
      }
    },
    [run]
  );

  return (
    <div className="query-editor">
      <textarea
        className="query-editor__textarea"
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Enter SQL query... (Ctrl+Enter to run)"
        rows={6}
        spellCheck={false}
      />
      <div className="query-editor__actions">
        <button
          className="query-editor__run-btn"
          onClick={run}
          disabled={running || !sql.trim()}
        >
          {running ? 'Running...' : 'Run Query'}
        </button>
      </div>
    </div>
  );
}
