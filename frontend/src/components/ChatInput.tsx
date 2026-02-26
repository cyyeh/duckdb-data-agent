import { useState, useRef } from 'react';
import { useTranslation } from '../hooks/useTranslation';
import { useAgent } from '../hooks/useAgent';
import './ChatInput.css';

export function ChatInput() {
  const { t } = useTranslation();
  const { sendMessage, isStreaming } = useAgent();
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    sendMessage(trimmed);
    setText('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 150) + 'px';
  };

  return (
    <div className="chat-input">
      <div className="chat-input__textarea-wrapper">
        <textarea
          ref={textareaRef}
          className="chat-input__textarea"
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder={isStreaming ? '' : t('chatPlaceholder')}
          disabled={isStreaming}
          rows={1}
        />
        {isStreaming && (
          <span className="chat-input__shimmer">{t('chatPlaceholderWaiting')}</span>
        )}
      </div>
      <button
        className="chat-input__send"
        onClick={handleSend}
        disabled={isStreaming || !text.trim()}
      >
        {t('send')}
      </button>
    </div>
  );
}
