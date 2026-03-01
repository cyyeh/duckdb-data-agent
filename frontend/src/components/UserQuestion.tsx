import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from '../hooks/useTranslation';
import { useAgent } from '../hooks/useAgent';
import type { UserQuestionData } from '../types';
import './UserQuestion.css';

export function UserQuestion({
  questionData,
  userAnswer,
  userFreeText,
}: {
  questionData: UserQuestionData;
  userAnswer?: string[];
  userFreeText?: string;
}) {
  const { t } = useTranslation();
  const { respondToQuestion } = useAgent();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [freeText, setFreeText] = useState('');
  const [showFreeText, setShowFreeText] = useState(false);
  const isAnswered = !!userAnswer;

  const handleOptionClick = (label: string) => {
    if (isAnswered) return;
    if (questionData.multiSelect) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(label)) next.delete(label);
        else next.add(label);
        return next;
      });
    } else {
      // Single-select: submit immediately
      respondToQuestion(questionData.questionId, [label]);
    }
  };

  const handleSubmitMulti = () => {
    if (isAnswered) return;
    const answers = [...selected];
    if (showFreeText && freeText.trim()) {
      respondToQuestion(questionData.questionId, answers, freeText.trim());
    } else {
      respondToQuestion(questionData.questionId, answers);
    }
  };

  const handleSubmitFreeText = () => {
    if (isAnswered || !freeText.trim()) return;
    respondToQuestion(questionData.questionId, [], freeText.trim());
  };

  if (isAnswered) {
    return (
      <div className="user-question user-question--answered">
        <div className="user-question__label">{t('questionAnswered')}</div>
        <div className="user-question__question"><ReactMarkdown remarkPlugins={[remarkGfm]}>{questionData.question}</ReactMarkdown></div>
        <div className="user-question__selected-answers">
          {userAnswer.map((a, i) => (
            <span key={i} className="user-question__selected-chip">{a}</span>
          ))}
          {userFreeText && (
            <span className="user-question__selected-chip">{userFreeText}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="user-question">
      <div className="user-question__label">{t('questionFromAgent')}</div>
      <div className="user-question__question"><ReactMarkdown remarkPlugins={[remarkGfm]}>{questionData.question}</ReactMarkdown></div>
      <div className="user-question__options">
        {questionData.options.map((opt, i) => (
          <button
            key={i}
            className={`user-question__option ${selected.has(opt.label) ? 'user-question__option--selected' : ''}`}
            onClick={() => handleOptionClick(opt.label)}
          >
            {questionData.multiSelect && (
              <span className="user-question__checkbox">
                {selected.has(opt.label) ? '\u2611' : '\u2610'}
              </span>
            )}
            <span className="user-question__option-label">{opt.label}</span>
            {opt.description && (
              <span className="user-question__option-desc">{opt.description}</span>
            )}
          </button>
        ))}
      </div>
      <div className="user-question__free-text-toggle">
        <button
          className="user-question__other-btn"
          onClick={() => setShowFreeText(!showFreeText)}
        >
          {showFreeText ? t('hideOther') : t('other')}
        </button>
      </div>
      {showFreeText && (
        <div className="user-question__free-text">
          <input
            type="text"
            className="user-question__free-text-input"
            placeholder={t('typeYourAnswer')}
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleSubmitFreeText();
              }
            }}
          />
          <button
            className="user-question__submit-btn"
            onClick={handleSubmitFreeText}
            disabled={!freeText.trim()}
          >
            {t('submit')}
          </button>
        </div>
      )}
      {questionData.multiSelect && selected.size > 0 && (
        <button className="user-question__submit-btn user-question__submit-multi" onClick={handleSubmitMulti}>
          {t('submit')} ({selected.size})
        </button>
      )}
    </div>
  );
}
