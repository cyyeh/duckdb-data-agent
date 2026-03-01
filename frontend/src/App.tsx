import { useState, useCallback, useEffect } from 'react';
import { ThemeProvider } from './contexts/ThemeContext';
import { useTheme } from './hooks/useTheme';
import { useSessionId } from './hooks/useSessionId';
import { LanguageProvider } from './contexts/LanguageContext';
import { useTranslation } from './hooks/useTranslation';
import { AgentProvider } from './contexts/AgentContext';
import { ConfigProvider } from './contexts/ConfigContext';
import { ConversationProvider, useConversation } from './contexts/ConversationContext';
import { FileUpload } from './components/FileUpload';
import { QueryEditor } from './components/QueryEditor';
import { ResultsTable } from './components/ResultsTable';
import { ResultMarkdown } from './components/ResultMarkdown';
import { Sidebar } from './components/Sidebar';
import { ErrorMessage } from './components/ErrorMessage';
import { AgentPanel } from './components/AgentPanel';
import { useAgent } from './hooks/useAgent';
import type { TableInfo, QueryResult } from './types';
import './App.css';

function findDuplicateFileNames(files: File[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const file of files) {
    if (seen.has(file.name)) {
      duplicates.add(file.name);
    }
    seen.add(file.name);
  }
  return Array.from(duplicates);
}

function AppContent({
  tables,
  refreshTables,
  sessionId,
}: {
  tables: TableInfo[];
  refreshTables: () => Promise<void>;
  sessionId: string;
}) {
  const { theme, toggleTheme } = useTheme();
  const { language, setLanguage, t } = useTranslation();
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | { key: string; params: Record<string, string> } | null>(null);
  const [editorQuery, setEditorQuery] = useState<string | undefined>(
    () => tables.length > 0 ? `SELECT * FROM "${tables[0].name}" LIMIT 100` : undefined
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.innerWidth < 768);
  const [agentOpen, setAgentOpen] = useState(true);
  const [pendingSkillCommand, setPendingSkillCommand] = useState<string | null>(null);

  const conversation = useConversation();
  const { clearMessages, loadMessages } = useAgent();

  const handleConversationSelect = useCallback(async (id: string) => {
    const outgoingId = conversation.activeConversationId;
    const messages = await conversation.selectConversation(id);
    loadMessages(messages, outgoingId, id);
  }, [conversation, loadMessages]);

  const handleNewConversation = useCallback(() => {
    const outgoingId = conversation.activeConversationId;
    conversation.startNewConversation();
    clearMessages(outgoingId);
  }, [conversation, clearMessages]);

  const handleConversationDelete = useCallback(async (id: string) => {
    await conversation.deleteConversation(id);
    if (conversation.activeConversationId === id) {
      clearMessages();
    }
  }, [conversation, clearMessages]);

  const handleConversationRename = useCallback(async (id: string, title: string) => {
    await conversation.renameConversation(id, title);
  }, [conversation]);

  useEffect(() => {
    document.title = t('appTitle');
  }, [t]);

  useEffect(() => {
    if (tables.length === 0) {
      setQueryResult(null);
      setError(null);
      setEditorQuery(undefined);
    }
  }, [tables]);

  const errorMessage = error
    ? (typeof error === 'string' ? error : t(error.key, error.params))
    : null;

  const handleAgentToggle = () => {
    setAgentOpen((prev) => !prev);
  };

  const handleLoadSample = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch('/api/upload/sample', { method: 'POST', headers: { 'X-Session-ID': sessionId } });
      if (!response.ok) throw new Error('Failed to load sample dataset');
      await refreshTables();
      setEditorQuery('SELECT * FROM "titanic" LIMIT 100');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load sample dataset');
    }
  }, [refreshTables, sessionId]);

  const handleFileUpload = useCallback(
    async (files: File[]) => {
      setError(null);

      // Check for duplicate filenames within the batch
      const batchDuplicates = findDuplicateFileNames(files);
      if (batchDuplicates.length > 0) {
        setError({ key: 'duplicateFilesInBatch', params: { names: batchDuplicates.join(', ') } });
        return;
      }

      // Check for filenames that match already-uploaded table names
      const existingNames = new Set(tables.map((tbl) => tbl.name));
      const alreadyUploaded = files.filter((f) => existingNames.has(f.name)).map((f) => f.name);
      if (alreadyUploaded.length > 0) {
        setError({ key: 'duplicateFilesExist', params: { names: alreadyUploaded.join(', ') } });
        return;
      }

      let lastName = '';
      try {
        for (const file of files) {
          const formData = new FormData();
          formData.append('file', file);
          const response = await fetch('/api/upload', {
            method: 'POST',
            headers: { 'X-Session-ID': sessionId },
            body: formData,
          });
          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.detail || 'Failed to upload file');
          }
          const result = await response.json();
          // Handle both single table and array of tables (Excel with multiple sheets)
          if (Array.isArray(result)) {
            lastName = result[result.length - 1]?.name || '';
          } else {
            lastName = result.name;
          }
        }
        await refreshTables();
        if (lastName) {
          setEditorQuery(`SELECT * FROM "${lastName}" LIMIT 100`);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to upload file');
      }
    },
    [refreshTables, sessionId, tables]
  );

  const handleQueryExecute = useCallback(
    async (sql: string) => {
      setError(null);
      setQueryResult(null);
      try {
        const start = performance.now();
        const response = await fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Session-ID': sessionId },
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
    [refreshTables, sessionId]
  );

  const handleTableClick = useCallback((tableName: string) => {
    setEditorQuery(`SELECT * FROM "${tableName}" LIMIT 100`);
  }, []);

  const handleTableDelete = useCallback(async (tableName: string) => {
    if (!confirm(t('deleteTableConfirm', { name: tableName }))) return;
    try {
      const response = await fetch(`/api/tables/${encodeURIComponent(tableName)}`, {
        method: 'DELETE',
        headers: { 'X-Session-ID': sessionId },
      });
      if (!response.ok) throw new Error('Failed to delete table');
      await refreshTables();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete table');
    }
  }, [refreshTables, t, sessionId]);

  const handleDeleteAll = useCallback(async () => {
    if (tables.length === 0) return;
    if (!confirm(t('deleteAllTablesConfirm'))) return;
    try {
      for (const table of tables) {
        const response = await fetch(`/api/tables/${encodeURIComponent(table.name)}`, {
          method: 'DELETE',
          headers: { 'X-Session-ID': sessionId },
        });
        if (!response.ok) throw new Error('Failed to delete table');
      }
      await refreshTables();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete tables');
    }
  }, [tables, refreshTables, t, sessionId]);

  const appClass = [
    'app',
    sidebarCollapsed ? 'app--sidebar-collapsed' : '',
  ].filter(Boolean).join(' ');

  const themeIcon = theme === 'dark' ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );

  return (
    <div className={appClass}>
      <div className="app__sidebar-wrapper">
        <Sidebar
          tables={tables}
          onTableClick={handleTableClick}
          onTableDelete={handleTableDelete}
          onUpload={handleFileUpload}
          onDeleteAll={handleDeleteAll}
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((prev) => !prev)}
          onUseSkill={(name) => setPendingSkillCommand(name)}
          activeConversationId={conversation.activeConversationId}
          onConversationSelect={handleConversationSelect}
          onConversationNew={handleNewConversation}
          onConversationDelete={handleConversationDelete}
          onConversationRename={handleConversationRename}
          conversationRefreshTrigger={conversation.refreshTrigger}
          sessionId={sessionId}
        />
      </div>
      {agentOpen ? (
        <div className="app__agent-wrapper">
          <div className="app__header">
            <h1 className="app__title">{t('appTitle')}</h1>
            <div className="app__header-actions">
              <button
                className="app__lang-toggle"
                onClick={() => setLanguage(language === 'en' ? 'zh-TW' : 'en')}
                aria-label={language === 'en' ? t('switchToZh') : t('switchToEn')}
                title={language === 'en' ? t('switchToZh') : t('switchToEn')}
              >
                {language === 'en' ? 'EN' : '中'}
              </button>
              <button
                className="app__theme-toggle"
                onClick={toggleTheme}
                aria-label={theme === 'dark' ? t('switchToLight') : t('switchToDark')}
                title={theme === 'dark' ? t('switchToLight') : t('switchToDark')}
              >
                {themeIcon}
              </button>
              <button
                className="app__agent-toggle app__agent-toggle--active"
                onClick={handleAgentToggle}
              >
                {t('editorMode')}
              </button>
            </div>
          </div>
          {errorMessage && (
            <ErrorMessage message={errorMessage} onDismiss={() => setError(null)} />
          )}
          <AgentPanel
            tables={tables}
            onUpload={handleFileUpload}
            onLoadSample={handleLoadSample}
            pendingSkillCommand={pendingSkillCommand}
            onSkillCommandConsumed={() => setPendingSkillCommand(null)}
          />
        </div>
      ) : (
        <div className="app__editor-wrapper">
          <div className="app__header">
            <h1 className="app__title">{t('appTitle')}</h1>
            <div className="app__header-actions">
              <button
                className="app__lang-toggle"
                onClick={() => setLanguage(language === 'en' ? 'zh-TW' : 'en')}
                aria-label={language === 'en' ? t('switchToZh') : t('switchToEn')}
                title={language === 'en' ? t('switchToZh') : t('switchToEn')}
              >
                {language === 'en' ? 'EN' : '中'}
              </button>
              <button
                className="app__theme-toggle"
                onClick={toggleTheme}
                aria-label={theme === 'dark' ? t('switchToLight') : t('switchToDark')}
                title={theme === 'dark' ? t('switchToLight') : t('switchToDark')}
              >
                {themeIcon}
              </button>
              <button
                className="app__agent-toggle"
                onClick={handleAgentToggle}
              >
                {t('agentMode')}
              </button>
            </div>
          </div>
          <div className="app__mode-header">
            <span className="app__mode-title">{t('editorMode')}</span>
          </div>
          {errorMessage && (
            <ErrorMessage message={errorMessage} onDismiss={() => setError(null)} />
          )}
          <main className="app__main">
            {tables.length === 0 ? (
              <div className="app__empty">
                <FileUpload onUpload={handleFileUpload} onLoadSample={handleLoadSample} />
              </div>
            ) : (
              <>
                <QueryEditor
                  onExecute={handleQueryExecute}
                  initialQuery={editorQuery}
                />
                {queryResult?.resultType === 'markdown' ? (
                  <ResultMarkdown result={queryResult} />
                ) : (
                  <ResultsTable result={queryResult} />
                )}
              </>
            )}
          </main>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const sessionId = useSessionId();
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshTables = useCallback(async () => {
    try {
      const response = await fetch('/api/tables', {
        headers: { 'X-Session-ID': sessionId },
      });
      if (!response.ok) throw new Error('Failed to fetch tables');
      const data = await response.json();
      setTables(data);
    } catch (e) {
      console.error('Failed to refresh tables:', e);
    }
  }, [sessionId]);

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
    <ConfigProvider>
      <LanguageProvider>
        <ThemeProvider>
          <ConversationProvider sessionId={sessionId}>
            <AgentProvider refreshTables={refreshTables}>
              <AppContent tables={tables} refreshTables={refreshTables} sessionId={sessionId} />
            </AgentProvider>
          </ConversationProvider>
        </ThemeProvider>
      </LanguageProvider>
    </ConfigProvider>
  );
}
