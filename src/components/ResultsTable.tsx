import { useState, useMemo, useRef, useEffect } from 'react';
import type { QueryResult } from '../types';
import './ResultsTable.css';

interface ResultsTableProps {
  result: QueryResult | null;
}

const DISPLAY_CAP = 1000;

interface SortConfig {
  column: string | null;
  direction: 'asc' | 'desc';
}

export function ResultsTable({ result }: ResultsTableProps) {
  const [sortConfig, setSortConfig] = useState<SortConfig>({ column: null, direction: 'asc' });
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [globalFilter, setGlobalFilter] = useState('');
  const prevResult = useRef<QueryResult | null>(null);

  useEffect(() => {
    if (result !== prevResult.current) {
      prevResult.current = result;
      setSortConfig({ column: null, direction: 'asc' });
      setColumnFilters({});
      setGlobalFilter('');
    }
  }, [result]);

  const filteredRows = useMemo(() => {
    if (!result) return [];
    let rows = result.rows;

    if (globalFilter) {
      const term = globalFilter.toLowerCase();
      rows = rows.filter((row) =>
        result.columns.some((col) => formatCell(row[col]).toLowerCase().includes(term))
      );
    }

    const activeFilters = Object.entries(columnFilters).filter(([, v]) => v);
    if (activeFilters.length > 0) {
      rows = rows.filter((row) =>
        activeFilters.every(([col, term]) =>
          formatCell(row[col]).toLowerCase().includes(term.toLowerCase())
        )
      );
    }

    return rows;
  }, [result, globalFilter, columnFilters]);

  const sortedRows = useMemo(() => {
    if (!sortConfig.column) return filteredRows;
    const col = sortConfig.column;
    const dir = sortConfig.direction === 'asc' ? 1 : -1;

    return [...filteredRows].sort((a, b) => {
      const aVal = a[col];
      const bVal = b[col];

      if (aVal === null || aVal === undefined) return 1;
      if (bVal === null || bVal === undefined) return -1;

      const aNum = Number(aVal);
      const bNum = Number(bVal);
      if (!isNaN(aNum) && !isNaN(bNum)) return (aNum - bNum) * dir;

      return String(aVal).localeCompare(String(bVal)) * dir;
    });
  }, [filteredRows, sortConfig]);

  if (!result) return null;

  const isFiltered = globalFilter || Object.values(columnFilters).some(Boolean);
  const displayRows = sortedRows.slice(0, DISPLAY_CAP);
  const truncated = sortedRows.length > DISPLAY_CAP;

  function handleSort(col: string) {
    setSortConfig((prev) => {
      if (prev.column !== col) return { column: col, direction: 'asc' };
      if (prev.direction === 'asc') return { column: col, direction: 'desc' };
      return { column: null, direction: 'asc' };
    });
  }

  function handleColumnFilter(col: string, value: string) {
    setColumnFilters((prev) => ({ ...prev, [col]: value }));
  }

  function getSortIcon(col: string) {
    if (sortConfig.column !== col) return ' ↕';
    return sortConfig.direction === 'asc' ? ' ↑' : ' ↓';
  }

  return (
    <div className="results-table">
      <div className="results-table__toolbar">
        <input
          className="results-table__global-search"
          type="text"
          placeholder="Search all columns…"
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
        />
      </div>
      <div className="results-table__summary">
        {isFiltered
          ? `${sortedRows.length} of ${result.rowCount} rows`
          : `${result.rowCount} row${result.rowCount !== 1 ? 's' : ''}`}{' '}
        in {result.executionTimeMs.toFixed(1)} ms
        {truncated && ` (showing first ${DISPLAY_CAP})`}
      </div>
      {result.columns.length > 0 && (
        <div className="results-table__scroll">
          <table className="results-table__table">
            <thead>
              <tr>
                {result.columns.map((col) => (
                  <th key={col}>
                    <button
                      className="results-table__col-header"
                      onClick={() => handleSort(col)}
                    >
                      {col}
                      <span
                        className={`results-table__sort-icon${sortConfig.column === col ? ' results-table__sort-icon--active' : ''}`}
                      >
                        {getSortIcon(col)}
                      </span>
                    </button>
                    <input
                      className="results-table__col-filter"
                      type="text"
                      placeholder="Filter…"
                      value={columnFilters[col] || ''}
                      onChange={(e) => handleColumnFilter(col, e.target.value)}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row, i) => (
                <tr key={i}>
                  {result.columns.map((col) => (
                    <td key={col}>{formatCell(row[col])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
