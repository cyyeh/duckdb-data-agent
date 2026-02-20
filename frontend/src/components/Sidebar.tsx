import { useRef, useState } from 'react';
import { useTranslation } from '../hooks/useTranslation';
import type { TableInfo } from '../types';
import './Sidebar.css';

interface SidebarProps {
  tables: TableInfo[];
  onTableClick: (tableName: string) => void;
  onTableDelete: (tableName: string) => void;
  onUpload: (files: File[]) => void;
  onDeleteAll: () => void;
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ tables, onTableClick, onTableDelete, onUpload, onDeleteAll, collapsed, onToggle }: SidebarProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    <div className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''}`}>
      <div className="sidebar__top">
        <div className="sidebar__header">
          <h3 className="sidebar__title">{t('tablesHeader')}</h3>
          <button
            className="sidebar__collapse-toggle"
            onClick={onToggle}
            aria-label={collapsed ? t('expandSidebar') : t('collapseSidebar')}
          >
            <span className="sidebar__hamburger" />
          </button>
        </div>
        <div className="sidebar__actions">
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
        </div>
      </div>
      <div className="sidebar__content">
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
      </div>
    </div>
  );
}
