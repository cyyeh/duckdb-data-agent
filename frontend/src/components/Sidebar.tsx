import { useState } from 'react';
import { useTranslation } from '../hooks/useTranslation';
import type { TableInfo } from '../types';
import './Sidebar.css';

interface SidebarProps {
  tables: TableInfo[];
  onTableClick: (tableName: string) => void;
  onTableDelete: (tableName: string) => void;
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ tables, onTableClick, onTableDelete, collapsed, onToggle }: SidebarProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggle = (name: string) => {
    setExpanded((prev) => ({ ...prev, [name]: !prev[name] }));
  };

  return (
    <div className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''}`}>
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
