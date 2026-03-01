import { useState, useEffect, useCallback } from 'react';
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

  const loadMemories = useCallback(async () => {
    try {
      const data = await fetchMemories();
      setEntries(data.entries);
    } catch {
      // silently ignore
    }
  }, []);

  useEffect(() => { loadMemories(); }, [loadMemories, refreshKey]);

  useEffect(() => {
    const handler = () => loadMemories();
    window.addEventListener('memories-updated', handler);
    return () => window.removeEventListener('memories-updated', handler);
  }, [loadMemories]);

  const handleDelete = async (content: string) => {
    if (!confirm(t('deleteMemoryConfirm'))) return;
    try {
      await apiDeleteMemory(content);
      await loadMemories();
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
              <li key={`${group.category}-${idx}`} className="memories-panel__item">
                <span className="memories-panel__text">{entry.content}</span>
                <button
                  className="memories-panel__delete-btn"
                  onClick={() => handleDelete(entry.content)}
                  title={t('deleteMemory')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
