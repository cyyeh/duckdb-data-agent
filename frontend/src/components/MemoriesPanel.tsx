import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '../hooks/useTranslation';
import { fetchMemories, deleteMemory as apiDeleteMemory } from '../services/memoriesService';
import type { MemoryEntry } from '../services/memoriesService';
import './MemoriesPanel.css';

interface MemoriesPanelProps {
  refreshKey: number;
}

const CATEGORY_ORDER: MemoryEntry['category'][] = ['preference', 'fact', 'pattern'];

const CATEGORY_I18N: Record<MemoryEntry['category'], string> = {
  preference: 'preferencesCategory',
  fact: 'factsCategory',
  pattern: 'patternsCategory',
};

export function MemoriesPanel({ refreshKey }: MemoriesPanelProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [raw, setRaw] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<MemoryEntry | null>(null);

  const loadMemories = useCallback(async () => {
    try {
      const data = await fetchMemories();
      setEntries(data.entries);
      setRaw(data.raw);
    } catch {
      // silently ignore
    }
  }, []);

  useEffect(() => { loadMemories(); }, [loadMemories, refreshKey]);

  const handleDelete = async (content: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(t('deleteMemoryConfirm'))) return;
    try {
      await apiDeleteMemory(content);
      setEntries((prev) => {
        const idx = prev.findIndex((m) => m.content === content);
        if (idx === -1) return prev;
        return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
      });
      if (selectedEntry?.content === content) setSelectedEntry(null);
    } catch {
      // silently ignore
    }
  };

  const grouped = CATEGORY_ORDER
    .map((cat) => ({ category: cat, items: entries.filter((e) => e.category === cat) }))
    .filter((g) => g.items.length > 0);

  if (entries.length === 0) {
    return (
      <div className="memories-panel">
        <p className="memories-panel__empty">{t('noMemories')}</p>
      </div>
    );
  }

  return (
    <div className="memories-panel">
      {grouped.map((group) => (
        <div key={group.category} className="memories-panel__section">
          <h3 className="memories-panel__section-title">{t(CATEGORY_I18N[group.category])}</h3>
          <ul className="memories-panel__list">
            {group.items.map((entry, idx) => (
              <li key={`${group.category}-${idx}`} className="memories-panel__item" onClick={() => setSelectedEntry(entry)}>
                <span className="memories-panel__text">{entry.content}</span>
                <button
                  className="memories-panel__delete-btn"
                  onClick={(e) => handleDelete(entry.content, e)}
                  title={t('deleteMemory')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {selectedEntry && createPortal(
        <div className="memory-detail-overlay" onClick={() => setSelectedEntry(null)}>
          <div className="memory-detail-modal" onClick={(e) => e.stopPropagation()}>
            <div className="memory-detail-modal__header">
              <span className="memory-detail-modal__category">{t(CATEGORY_I18N[selectedEntry.category])}</span>
              <button className="memory-detail-modal__close" onClick={() => setSelectedEntry(null)}>
                &times;
              </button>
            </div>
            <p className="memory-detail-modal__entry">{selectedEntry.content}</p>
            <p className="memory-detail-modal__context-label">{t('memoryContext')}</p>
            <pre className="memory-detail-modal__context">{raw}</pre>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
