import { useEffect, useRef } from 'react';
import { useTranslation } from '../LanguageContext';
import { useAgent } from '../useAgent';
import { ChatInput } from './ChatInput';
import { MessageBubble } from './MessageBubble';
import { FileUpload } from './FileUpload';
import type { LangfuseStatus, TableInfo } from '../types';
import './AgentPanel.css';

interface AgentPanelProps {
  langfuseStatus: LangfuseStatus;
  tables: TableInfo[];
  onUpload: (file: File) => Promise<void>;
  onLoadSample: () => Promise<void>;
}

export function AgentPanel({ langfuseStatus, tables, onUpload, onLoadSample }: AgentPanelProps) {
  const { t } = useTranslation();
  const { messages, clearMessages } = useAgent();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="agent-panel">
      <div className="agent-panel__header">
        <span className="agent-panel__title">{t('agentMode')}</span>
        <div className="agent-panel__actions">
          <button
            className={`agent-panel__langfuse ${!langfuseStatus.enabled ? 'agent-panel__langfuse--disabled' : ''}`}
            disabled={!langfuseStatus.enabled}
            title={langfuseStatus.enabled ? t('openLangfuse') : t('langfuseNotConfigured')}
            onClick={() => {
              if (langfuseStatus.dashboardUrl) {
                window.open(langfuseStatus.dashboardUrl, '_blank', 'noopener,noreferrer');
              }
            }}
          >
            <img src="/langfuse-color.svg" alt="Langfuse" className="agent-panel__langfuse-icon" />
            {t('langfuseTraces')}
          </button>
          {messages.length > 0 && (
            <button className="agent-panel__clear" onClick={clearMessages}>
              {t('clear')}
            </button>
          )}
        </div>
      </div>
      <div className="agent-panel__messages">
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
