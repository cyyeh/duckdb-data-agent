import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from '../hooks/useTranslation';
import './ConversationHistory.css';

interface Conversation {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

interface ConversationHistoryProps {
  activeConversationId: string | null;
  onSelect: (conversationId: string) => void;
  onNew: () => void;
  onDelete: (conversationId: string) => void;
  onRename: (conversationId: string, title: string) => void;
  refreshTrigger: number;
}

function timeAgo(dateStr: string, t: (key: string, params?: Record<string, string | number>) => string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (seconds < 60) return t('timeJustNow');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('timeMinutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('timeHoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t('timeDaysAgo', { count: days });
  return date.toLocaleDateString();
}

export function ConversationHistory({
  activeConversationId,
  onSelect,
  onNew,
  onDelete,
  onRename,
  refreshTrigger,
}: ConversationHistoryProps) {
  const { t } = useTranslation();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  const fetchConversations = useCallback(async () => {
    try {
      const res = await fetch('/api/conversations');
      if (res.ok) {
        setConversations(await res.json());
      }
    } catch {
      // Sidebar fetch failure: show empty list
    }
  }, []);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations, refreshTrigger]);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const handleRenameSubmit = (id: string) => {
    const trimmed = editTitle.trim();
    if (trimmed) {
      onRename(id, trimmed);
    }
    setEditingId(null);
  };

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (confirm(t('deleteConversationConfirm'))) {
      onDelete(id);
    }
  };

  const handleStartRename = (e: React.MouseEvent, id: string, currentTitle: string) => {
    e.stopPropagation();
    setEditingId(id);
    setEditTitle(currentTitle || '');
  };

  return (
    <div className="conv-history">
      <div className="conv-history__header">
        <span className="conv-history__title">{t('conversations')}</span>
        <button className="conv-history__new-btn" onClick={onNew} title={t('newConversation')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
      <div className="conv-history__list">
        {conversations.length === 0 ? (
          <div className="conv-history__empty">{t('noConversationsYet')}</div>
        ) : (
          conversations.map((conv) => (
            <div
              key={conv.id}
              className={`conv-history__item ${conv.id === activeConversationId ? 'conv-history__item--active' : ''}`}
              onClick={() => onSelect(conv.id)}
            >
              {editingId === conv.id ? (
                <input
                  ref={editInputRef}
                  className="conv-history__edit-input"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onBlur={() => handleRenameSubmit(conv.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRenameSubmit(conv.id);
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <>
                  <div className="conv-history__item-title">
                    {conv.title || t('untitled')}
                  </div>
                  <div className="conv-history__item-meta">
                    <span className="conv-history__item-time">{timeAgo(conv.updated_at, t)}</span>
                    <span className="conv-history__item-actions">
                      <button
                        className="conv-history__action-btn"
                        onClick={(e) => handleStartRename(e, conv.id, conv.title || '')}
                        title={t('rename')}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                      </button>
                      <button
                        className="conv-history__action-btn conv-history__action-btn--danger"
                        onClick={(e) => handleDelete(e, conv.id)}
                        title={t('deleteConversation')}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </span>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
