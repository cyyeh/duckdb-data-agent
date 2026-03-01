import { useState, useRef, useEffect } from 'react';
import { useTranslation } from '../hooks/useTranslation';
import { useAgent } from '../hooks/useAgent';
import { useConversation } from '../contexts/ConversationContext';
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
  const { activeConversationId, createConversation, triggerRefresh } = useConversation();
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');

  // Load skills on mount and refresh when toggled/updated
  useEffect(() => {
    fetchSkills().then(setSkills).catch(() => {});
    const handler = () => { fetchSkills().then(setSkills).catch(() => {}); };
    window.addEventListener('skills-updated', handler);
    return () => window.removeEventListener('skills-updated', handler);
  }, []);

  // Consume pending skill command from sidebar "Use" button
  useEffect(() => {
    if (pendingSkillCommand) {
      setText(prev => {
        const trimmed = prev.trim();
        const command = `${t('useSkillPlaceholder')} /${pendingSkillCommand}`;
        return trimmed ? `${trimmed} ${command}` : command;
      });
      onSkillCommandConsumed?.();
      textareaRef.current?.focus();
    }
  }, [pendingSkillCommand, onSkillCommandConsumed]);

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    setText('');
    setShowSlashMenu(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    let convId = activeConversationId;
    if (!convId) {
      convId = await createConversation(trimmed);
    }
    await sendMessage(trimmed, convId);
    triggerRefresh();
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

  const slashStartRef = useRef<number>(-1);

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    const cursorPos = e.target.selectionStart;
    setText(val);

    // Find the slash token at or before the cursor
    const beforeCursor = val.slice(0, cursorPos);
    const slashIdx = beforeCursor.lastIndexOf('/');
    if (slashIdx !== -1) {
      const token = beforeCursor.slice(slashIdx + 1);
      // Valid slash command: no spaces in the token
      if (!token.includes(' ')) {
        slashStartRef.current = slashIdx;
        setShowSlashMenu(true);
        setSlashFilter(token);
      } else {
        setShowSlashMenu(false);
      }
    } else {
      setShowSlashMenu(false);
    }

    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 150) + 'px';
  };

  const handleSlashSelect = (skillName: string) => {
    const start = slashStartRef.current;
    const cursorPos = textareaRef.current?.selectionStart ?? text.length;
    const before = text.slice(0, start);
    const after = text.slice(cursorPos);
    setText(`${before}/${skillName} ${after}`);
    setShowSlashMenu(false);
    slashStartRef.current = -1;
    // Set cursor after the inserted command
    const newCursorPos = start + skillName.length + 2; // "/" + name + " "
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos);
    });
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
