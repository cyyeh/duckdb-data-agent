import { useState, useCallback, useEffect } from 'react';
import { AgentProvider } from './AgentContext';
import { FileUpload } from './components/FileUpload';
import { QueryEditor } from './components/QueryEditor';
import { ResultsTable } from './components/ResultsTable';
import { ResultMarkdown } from './components/ResultMarkdown';
import { Sidebar } from './components/Sidebar';
import { ErrorMessage } from './components/ErrorMessage';
import { AgentPanel } from './components/AgentPanel';
import type { TableInfo, QueryResult } from './types';
import './App.css';

function AppContent({ tables, refreshTables }: { tables: TableInfo[]; refreshTables: () => Promise<void> }) {
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editorQuery, setEditorQuery] = useState<string | undefined>(undefined);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);

  const handleAgentToggle = () => {
    setAgentOpen((prev) => !prev);
  };

  const handleLoadSample = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch('/api/upload/sample', { method: 'POST' });
      if (!response.ok) throw new Error('Failed to load sample dataset');
      await refreshTables();
      setEditorQuery('SELECT * FROM "titanic" LIMIT 100');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load sample dataset');
    }
  }, [refreshTables]);

  const handleFileUpload = useCallback(
    async (file: File) => {
      setError(null);
      try {
        const formData = new FormData();
        formData.append('file', file);
        const response = await fetch('/api/upload', {
          method: 'POST',
          body: formData,
        });
        if (!response.ok) throw new Error('Failed to upload file');
        const result = await response.json();
        await refreshTables();
        setEditorQuery(`SELECT * FROM "${result.name}" LIMIT 100`);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to upload file');
      }
    },
    [refreshTables]
  );

  const handleQueryExecute = useCallback(
    async (sql: string) => {
      setError(null);
      setQueryResult(null);
      try {
        const start = performance.now();
        const response = await fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql }),
        });
        const elapsed = performance.now() - start;

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.detail || 'Query execution failed');
        }

        const result = await response.json();
        setQueryResult({
          columns: result.columns,
          rows: result.rows,
          rowCount: result.rowCount,
          executionTimeMs: elapsed,
          resultType: result.resultType,
        });
        await refreshTables();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Query execution failed');
      }
    },
    [refreshTables]
  );

  const handleTableClick = useCallback((tableName: string) => {
    setEditorQuery(`SELECT * FROM "${tableName}" LIMIT 100`);
  }, []);

  const handleTableDelete = useCallback(async (tableName: string) => {
    if (!confirm(`Delete table "${tableName}"?`)) return;
    try {
      const response = await fetch(`/api/tables/${encodeURIComponent(tableName)}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('Failed to delete table');
      await refreshTables();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete table');
    }
  }, [refreshTables]);

  const appClass = [
    'app',
    sidebarCollapsed ? 'app--sidebar-collapsed' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={appClass}>
      <div className="app__sidebar-wrapper">
        <Sidebar tables={tables} onTableClick={handleTableClick} onTableDelete={handleTableDelete} collapsed={sidebarCollapsed} />
        <button
          className="app__sidebar-toggle"
          onClick={() => setSidebarCollapsed((prev) => !prev)}
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {sidebarCollapsed ? '\u25B6' : '\u25C0'}
        </button>
      </div>
      {agentOpen ? (
        <div className="app__agent-wrapper">
          <div className="app__header">
            <h1 className="app__title">DuckDB Data Agent</h1>
            <button
              className="app__agent-toggle app__agent-toggle--active"
              onClick={handleAgentToggle}
            >
              Editor Mode
            </button>
          </div>
          <AgentPanel />
        </div>
      ) : (
        <main className="app__main">
          <div className="app__header">
            <h1 className="app__title">DuckDB Data Agent</h1>
            <button
              className="app__agent-toggle"
              onClick={handleAgentToggle}
            >
              Agent Mode
            </button>
          </div>
          <FileUpload onUpload={handleFileUpload} onLoadSample={handleLoadSample} />
          <QueryEditor
            onExecute={handleQueryExecute}
            initialQuery={editorQuery}
          />
          {error && (
            <ErrorMessage message={error} onDismiss={() => setError(null)} />
          )}
          {queryResult?.resultType === 'markdown' ? (
            <ResultMarkdown result={queryResult} />
          ) : (
            <ResultsTable result={queryResult} />
          )}
        </main>
      )}
    </div>
  );
}

export default function App() {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshTables = useCallback(async () => {
    try {
      const response = await fetch('/api/tables');
      if (!response.ok) throw new Error('Failed to fetch tables');
      const data = await response.json();
      setTables(data);
    } catch (e) {
      console.error('Failed to refresh tables:', e);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const response = await fetch('/api/health');
        if (!response.ok) throw new Error('Backend is not available');
        await refreshTables();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to connect to backend');
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshTables]);

  if (loading) {
    return <div className="app-loading">Connecting to backend...</div>;
  }

  if (error) {
    return (
      <div className="app-error">Failed to connect: {error}</div>
    );
  }

  return (
    <AgentProvider tables={tables} refreshTables={refreshTables}>
      <AppContent tables={tables} refreshTables={refreshTables} />
    </AgentProvider>
  );
}
