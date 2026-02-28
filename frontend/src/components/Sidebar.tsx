import { useRef, useState } from 'react';
import { useTranslation } from '../hooks/useTranslation';
import type { TableInfo } from '../types';
import { SkillsPanel } from './SkillsPanel';
import { CreateSkillDialog } from './CreateSkillDialog';
import './Sidebar.css';

interface SidebarProps {
  tables: TableInfo[];
  onTableClick: (tableName: string) => void;
  onTableDelete: (tableName: string) => void;
  onUpload: (files: File[]) => void;
  onDeleteAll: () => void;
  collapsed: boolean;
  onToggle: () => void;
  onUseSkill?: (skillName: string) => void;
}

export function Sidebar({ tables, onTableClick, onTableDelete, onUpload, onDeleteAll, collapsed, onToggle, onUseSkill }: SidebarProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState<'tables' | 'skills'>('tables');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [skillsRefreshKey, setSkillsRefreshKey] = useState(0);

  const toggle = (name: string) => {
    setExpanded((prev) => ({ ...prev, [name]: !prev[name] }));
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      onUpload(Array.from(files));
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <>
    <div className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''}`}>
      <div className="sidebar__top">
        <div className="sidebar__header">
          <div className="sidebar__tabs">
            <button
              className={`sidebar__tab ${activeTab === 'tables' ? 'sidebar__tab--active' : ''}`}
              onClick={() => setActiveTab('tables')}
            >
              {t('tablesTab')}
            </button>
            <button
              className={`sidebar__tab ${activeTab === 'skills' ? 'sidebar__tab--active' : ''}`}
              onClick={() => setActiveTab('skills')}
            >
              {t('skillsTab')}
            </button>
          </div>
          <button
            className="sidebar__collapse-toggle"
            onClick={onToggle}
            aria-label={collapsed ? t('expandSidebar') : t('collapseSidebar')}
          >
            <span className="sidebar__hamburger" />
          </button>
        </div>
        {activeTab === 'tables' && <div className="sidebar__actions">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".csv,.json,.parquet,.xlsx"
            onChange={handleFileChange}
            hidden
          />
          <button
            className="sidebar__action-btn"
            onClick={() => fileInputRef.current?.click()}
            title={t('uploadFiles')}
            aria-label={t('uploadFiles')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </button>
          <button
            className="sidebar__action-btn sidebar__action-btn--danger"
            onClick={onDeleteAll}
            title={t('deleteAllTables')}
            aria-label={t('deleteAllTables')}
            disabled={tables.length === 0}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>}
      </div>
      <div className="sidebar__content">
        {activeTab === 'tables' ? (
          <>
            {tables.length === 0 && (
              <p className="sidebar__empty">{t('noTables')}</p>
            )}
            <ul className="sidebar__list">
              {tables.map((table) => (
                <li key={table.name} className="sidebar__item">
                  <div className="sidebar__table-header">
                    <button
                      className="sidebar__toggle"
                      onClick={() => toggle(table.name)}
                    >
                      {expanded[table.name] ? '\u25BC' : '\u25B6'}
                    </button>
                    <button
                      className="sidebar__table-name"
                      onClick={() => { onTableClick(table.name); toggle(table.name); }}
                      title={table.name}
                    >
                      {table.name}
                    </button>
                    <span className="sidebar__row-count">
                      {t('rowCount', { count: table.rowCount })}
                    </span>
                    <button
                      className="sidebar__delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        onTableDelete(table.name);
                      }}
                      title={t('deleteTable', { name: table.name })}
                      aria-label={t('deleteTable', { name: table.name })}
                    >
                      🗑
                    </button>
                  </div>
                  {expanded[table.name] && (
                    <ul className="sidebar__columns">
                      {table.columns.map((col) => (
                        <li key={col.name} className="sidebar__column">
                          <span className="sidebar__col-name">{col.name}</span>
                          <span className="sidebar__col-type">{col.type}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <SkillsPanel
            onUseSkill={onUseSkill ?? (() => {})}
            onCreateClick={() => setShowCreateDialog(true)}
            refreshKey={skillsRefreshKey}
          />
        )}
      </div>
      <div className="sidebar__footer">
        <a
          href="https://github.com/cyyeh/duckdb-data-agent"
          target="_blank"
          rel="noopener noreferrer"
          className="sidebar__github-link"
          title={t('viewOnGitHub')}
          aria-label={t('viewOnGitHub')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
          </svg>
        </a>
      </div>
    </div>
    {showCreateDialog && (
      <CreateSkillDialog
        onClose={() => setShowCreateDialog(false)}
        onCreated={() => setSkillsRefreshKey((k) => k + 1)}
      />
    )}
    </>
  );
}
