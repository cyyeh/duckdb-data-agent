import { useState, useRef, useEffect } from 'react';
import { useTranslation } from '../hooks/useTranslation';
import { useAgent } from '../hooks/useAgent';
import { SlashCommandMenu } from './SlashCommandMenu';
import { fetchSkills } from '../services/skillsService';
import type { SkillInfo } from '../types';
import './ChatInput.css';

interface ChatInputProps {
  pendingSkillCommand?: string | null;
  onSkillCommandConsumed?: () => void;
}

export function ChatInput({ pendingSkillCommand, onSkillCommandConsumed }: ChatInputProps) {
  const { t } = useTranslation();
  const { sendMessage, isStreaming } = useAgent();
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');

  // Load skills once on mount
  useEffect(() => {
    fetchSkills().then(setSkills).catch(() => {});
  }, []);

  // Consume pending skill command from sidebar "Use" button
  useEffect(() => {
    if (pendingSkillCommand) {
      setText(`${t('useSkillPlaceholder')} /${pendingSkillCommand}`);
      onSkillCommandConsumed?.();
      textareaRef.current?.focus();
    }
  }, [pendingSkillCommand, onSkillCommandConsumed]);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    sendMessage(trimmed);
    setText('');
    setShowSlashMenu(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // When slash menu is open, let it handle arrow keys and Enter
    if (showSlashMenu) {
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) {
        return; // SlashCommandMenu handles these via document listener
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);

    // Show slash menu when input starts with / and has no space yet
    if (val.startsWith('/') && val.indexOf(' ') === -1) {
      setShowSlashMenu(true);
      setSlashFilter(val.slice(1));
    } else {
      setShowSlashMenu(false);
    }

    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 150) + 'px';
  };

  const handleSlashSelect = (skillName: string) => {
    setText(`/${skillName} `);
    setShowSlashMenu(false);
    textareaRef.current?.focus();
  };

  return (
    <div className="chat-input">
      <div className="chat-input__textarea-wrapper">
        {showSlashMenu && skills.length > 0 && (
          <SlashCommandMenu
            skills={skills}
            filter={slashFilter}
            onSelect={handleSlashSelect}
            onClose={() => setShowSlashMenu(false)}
          />
        )}
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
