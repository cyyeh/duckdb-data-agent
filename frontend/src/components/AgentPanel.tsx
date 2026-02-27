import { useEffect, useRef, useCallback } from 'react';
import { useTranslation } from '../hooks/useTranslation';
import { useAgent } from '../hooks/useAgent';
import { ChatInput } from './ChatInput';
import { MessageBubble } from './MessageBubble';
import { FileUpload } from './FileUpload';
import type { TableInfo } from '../types';
import './AgentPanel.css';
import { exportConversation } from '../utils/exportConversation';

interface AgentPanelProps {
  tables: TableInfo[];
  onUpload: (files: File[]) => Promise<void>;
  onLoadSample: () => Promise<void>;
}

export function AgentPanel({ tables, onUpload, onLoadSample }: AgentPanelProps) {
  const { t } = useTranslation();
  const { messages, clearMessages } = useAgent();
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  const isNearBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  const handleScroll = useCallback(() => {
    userScrolledUp.current = !isNearBottom();
  }, [isNearBottom]);

  useEffect(() => {
    if (!userScrolledUp.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  return (
    <div className="agent-panel">
      <div className="agent-panel__header">
        <span className="agent-panel__title">{t('agentMode')}</span>
        <div className="agent-panel__actions">
          {messages.length > 0 && (
            <button className="agent-panel__clear" onClick={() => exportConversation()}>
              {t('export')}
            </button>
          )}
          {messages.length > 0 && (
            <button className="agent-panel__clear" onClick={() => { if (confirm(t('clearConfirm'))) clearMessages(); }}>
              {t('clear')}
            </button>
          )}
        </div>
      </div>
      <div className="agent-panel__messages" ref={scrollContainerRef} onScroll={handleScroll}>
        {messages.length === 0 && (
          <div className="agent-panel__empty">
            {tables.length === 0 ? (
              <FileUpload onUpload={onUpload} onLoadSample={onLoadSample} />
            ) : (
              t('agentEmptyState')
            )}
          </div>
        )}
        {messages.map((msg, index) => (
          <MessageBubble key={msg.id} message={msg} messageIndex={index} />
        ))}
        <div ref={bottomRef} />
      </div>
      <ChatInput />
    </div>
  );
}
