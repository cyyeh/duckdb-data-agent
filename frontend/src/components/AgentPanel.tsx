import { useEffect, useRef } from 'react';
import { useAgent } from '../AgentContext';
import { ChatInput } from './ChatInput';
import { MessageBubble } from './MessageBubble';
import './AgentPanel.css';

export function AgentPanel() {
  const { messages, clearMessages } = useAgent();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="agent-panel">
      <div className="agent-panel__header">
        <span className="agent-panel__title">Agent Mode</span>
        {messages.length > 0 && (
          <button className="agent-panel__clear" onClick={clearMessages}>
            Clear
          </button>
        )}
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
