import { useEffect, useRef } from 'react';
import { useTranslation } from '../LanguageContext';
import { useAgent } from '../useAgent';
import { ChatInput } from './ChatInput';
import { MessageBubble } from './MessageBubble';
import type { LangfuseStatus } from '../types';
import './AgentPanel.css';

interface AgentPanelProps {
  langfuseStatus: LangfuseStatus;
}

export function AgentPanel({ langfuseStatus }: AgentPanelProps) {
  const { t } = useTranslation();
  const { messages, clearMessages } = useAgent();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="agent-panel">
      <div className="agent-panel__header">
        <span className="agent-panel__title">{t('agentHeader')}</span>
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
            {t('agentEmptyState')}
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
