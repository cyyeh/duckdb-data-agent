import { useEffect, useRef } from 'react';
import { useAgent } from '../AgentContext';
import { ChatInput } from './ChatInput';
import { MessageBubble } from './MessageBubble';
import type { LangfuseStatus } from '../types';
import './AgentPanel.css';

interface AgentPanelProps {
  langfuseStatus: LangfuseStatus;
}

export function AgentPanel({ langfuseStatus }: AgentPanelProps) {
  const { messages, clearMessages } = useAgent();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="agent-panel">
      <div className="agent-panel__header">
        <span className="agent-panel__title">Agent Mode</span>
        <div className="agent-panel__actions">
          <button
            className={`agent-panel__langfuse ${!langfuseStatus.enabled ? 'agent-panel__langfuse--disabled' : ''}`}
            disabled={!langfuseStatus.enabled}
            title={langfuseStatus.enabled ? 'Open Langfuse dashboard' : 'Langfuse not configured'}
            onClick={() => {
              if (langfuseStatus.dashboardUrl) {
                window.open(langfuseStatus.dashboardUrl, '_blank', 'noopener,noreferrer');
              }
            }}
          >
            <img src="/langfuse-color.svg" alt="Langfuse" className="agent-panel__langfuse-icon" />
            Langfuse Traces
          </button>
          {messages.length > 0 && (
            <button className="agent-panel__clear" onClick={clearMessages}>
              Clear
            </button>
          )}
        </div>
      </div>
      <div className="agent-panel__messages">
        {messages.length === 0 && (
          <div className="agent-panel__empty">
            Ask a question about your data, and the agent will write and run SQL queries to find the answer.
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        <div ref={bottomRef} />
      </div>
      <ChatInput />
    </div>
  );
}
