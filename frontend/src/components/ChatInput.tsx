import { useState, useRef } from 'react';
import { useTranslation } from '../LanguageContext';
import { useAgent } from '../useAgent';
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
    if (e.key === 'Enter' && !e.shiftKey) {
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
      <textarea
        ref={textareaRef}
        className="chat-input__textarea"
        value={text}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        placeholder={isStreaming ? t('chatPlaceholderWaiting') : t('chatPlaceholder')}
        disabled={isStreaming}
        rows={1}
      />
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
