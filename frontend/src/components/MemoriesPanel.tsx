import { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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

const CATEGORY_EMPTY_I18N: Record<MemoryEntry['category'], string> = {
  preference: 'noPreferences',
  fact: 'noFacts',
  pattern: 'noPatterns',
};

export function MemoriesPanel({ refreshKey }: MemoriesPanelProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [rawContent, setRawContent] = useState('');
  const [showFileModal, setShowFileModal] = useState(false);
  const [detailTab, setDetailTab] = useState<'preview' | 'source'>('preview');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  const loadMemories = useCallback(async () => {
    try {
      const data = await fetchMemories();
      setEntries(data.entries);
      setRawContent(data.raw);
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

  const handleViewFile = () => {
    setDetailTab('preview');
    setShowFileModal(true);
  };

  const filteredEntries = useMemo(() => {
    if (!searchTerm) return entries;
    const q = searchTerm.toLowerCase();
    return entries.filter((e) => e.content.toLowerCase().includes(q));
  }, [entries, searchTerm]);

  const grouped = CATEGORY_ORDER
    .map((cat) => ({ category: cat, items: filteredEntries.filter((e) => e.category === cat) }));

  return (
    <div className="memories-panel">
      <div className="memories-panel__actions">
        <button
          className="memories-panel__action-btn"
          onClick={handleViewFile}
          title={t('viewMemoryFile')}
          aria-label={t('viewMemoryFile')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
        </button>
        <button
          className={`memories-panel__action-btn${searchOpen ? ' memories-panel__action-btn--active' : ''}`}
          onClick={() => { setSearchOpen((v) => !v); if (searchOpen) setSearchTerm(''); }}
          title={t('searchMemories')}
          aria-label={t('searchMemories')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </button>
      </div>
      {searchOpen && (
        <input
          className="memories-panel__search-input"
          type="text"
          placeholder={t('searchMemoriesPlaceholder')}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          autoFocus
        />
      )}
      {grouped.map((group) => (
        <div key={group.category} className="memories-panel__section">
          <h3 className="memories-panel__section-title">{t(CATEGORY_I18N[group.category])}</h3>
          {group.items.length === 0 ? (
            <p className="memories-panel__section-empty">{t(CATEGORY_EMPTY_I18N[group.category])}</p>
          ) : (
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
          )}
        </div>
      ))}

      {showFileModal && createPortal(
        <div className="skill-detail-overlay" onClick={() => setShowFileModal(false)}>
          <div className="skill-detail-modal" onClick={(e) => e.stopPropagation()}>
            <div className="skill-detail-modal__header">
              <span className="skill-detail-modal__name">{t('memoryFileTitle')}</span>
              <button className="skill-detail-modal__close" onClick={() => setShowFileModal(false)}>
                &times;
              </button>
            </div>
            <div className="skill-detail-modal__tabs">
              <button
                className={`skill-detail-modal__tab${detailTab === 'preview' ? ' skill-detail-modal__tab--active' : ''}`}
                onClick={() => setDetailTab('preview')}
              >
                {t('memoryPreview')}
              </button>
              <button
                className={`skill-detail-modal__tab${detailTab === 'source' ? ' skill-detail-modal__tab--active' : ''}`}
                onClick={() => setDetailTab('source')}
              >
                {t('memorySource')}
              </button>
            </div>
            {detailTab === 'preview' ? (
              <div className="skill-detail-modal__content skill-detail-modal__content--preview">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{rawContent || '*No content*'}</ReactMarkdown>
              </div>
            ) : (
              <pre className="skill-detail-modal__content">{rawContent || ''}</pre>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
