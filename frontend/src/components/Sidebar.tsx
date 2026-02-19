import { useState } from 'react';
import type { TableInfo } from '../types';
import './Sidebar.css';

interface SidebarProps {
  tables: TableInfo[];
  onTableClick: (tableName: string) => void;
  onTableDelete: (tableName: string) => void;
  collapsed: boolean;
}

export function Sidebar({ tables, onTableClick, onTableDelete, collapsed }: SidebarProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggle = (name: string) => {
    setExpanded((prev) => ({ ...prev, [name]: !prev[name] }));
  };

  return (
    <div className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''}`}>
      <h3 className="sidebar__title">Tables</h3>
      {tables.length === 0 && (
        <p className="sidebar__empty">No tables yet. Upload a CSV to get started.</p>
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
                onClick={() => onTableClick(table.name)}
                title={`SELECT * FROM "${table.name}" LIMIT 100`}
              >
                {table.name}
              </button>
              <span className="sidebar__row-count">
                {table.rowCount} row{table.rowCount !== 1 ? 's' : ''}
              </span>
              <button
                className="sidebar__delete"
                onClick={(e) => {
                  e.stopPropagation();
                  onTableDelete(table.name);
                }}
                title={`Delete table "${table.name}"`}
                aria-label={`Delete table ${table.name}`}
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
  );
}
