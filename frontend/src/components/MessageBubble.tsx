import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from '../hooks/useTranslation';
import type { ChatMessage, ContentSegment } from '../types';
import { useAgent } from '../hooks/useAgent';
import { InlineQueryResult } from './InlineQueryResult';
import { ChartWidget } from './ChartWidget';
import { UserQuestion } from './UserQuestion';
import './MessageBubble.css';

/**
 * Strip chart_spec JSON code blocks from answer text.
 * The orchestrator may include the raw chart spec JSON even though the chart
 * is rendered separately. Remove ```json ... ``` blocks containing chart_spec
 * or Plotly trace data so they don't appear as raw text.
 */
function stripChartSpecBlocks(text: string): string {
  return text.replace(/```(?:json)?\s*\n?\s*\{[\s\S]*?"(?:chart_spec|data)"[\s\S]*?\}\s*\n?\s*```/g, '').trim();
}

function getLastThinkingLine(segments: ContentSegment[], streamingRemainder: string | undefined, t: (key: string) => string): string {
  // Use streaming remainder if available
  if (streamingRemainder?.trim()) {
    const lines = streamingRemainder.trim().split('\n').filter((l) => l.trim());
    const last = lines[lines.length - 1] || '';
    return last.length > 100 ? last.slice(0, 100) + '...' : last;
  }
  // Otherwise use last thinking segment's last line
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].type === 'thinking' && segments[i].text?.trim()) {
      const lines = segments[i].text!.trim().split('\n').filter((l) => l.trim());
      const last = lines[lines.length - 1] || '';
      return last.length > 100 ? last.slice(0, 100) + '...' : last;
    }
  }
  return t('thinking');
}

function ThinkingBlock({ segments, streamingRemainder, isThinkingPhase, isAgentStreaming }: {
  segments: ContentSegment[];
  streamingRemainder?: string;
  isThinkingPhase: boolean;
  isAgentStreaming: boolean;
}) {
  const { t } = useTranslation();
  // All non-answer, non-chart, non-user_question segments go inside the thinking block
  const thinkingSegments = segments.filter(
    (s) => s.type !== 'answer' && s.type !== 'user_question' && !(s.type === 'tool' && s.toolResult?.chart_spec) && !(s.type === 'subagent_end' && (s.chart_spec || s.text?.trim()))
  );
  const hasContent = thinkingSegments.some(
    (s) => (s.type === 'thinking' && s.text?.trim()) || (s.type === 'tool' && s.toolResult) || s.type === 'subagent_start'
  ) || streamingRemainder?.trim();

  if (!hasContent) return null;

  // Show preview only while agent is still working (hidden by CSS when collapsible is open anyway)
  const summary = isAgentStreaming ? getLastThinkingLine(segments, streamingRemainder, t) : '';

  return (
    <details className="message-bubble__segment message-bubble__segment--thinking message-bubble__collapsible" open={isThinkingPhase || undefined}>
      <summary className="message-bubble__collapsible-summary">
        <span className="message-bubble__segment-label">{t('thinkingLabel')}</span>
        {summary && <span className="message-bubble__collapsible-preview">{summary}</span>}
      </summary>
      <div className="message-bubble__thinking-body">
        {thinkingSegments.map((seg, i) => {
          if (seg.type === 'thinking' && seg.text?.trim()) {
            return (
              <div key={i} className="message-bubble__segment-content">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{seg.text}</ReactMarkdown>
              </div>
            );
          }
          if (seg.type === 'tool' && seg.toolResult) {
            return (
              <div key={i} className="message-bubble__tool-segment">
                <InlineQueryResult result={seg.toolResult} />
              </div>
            );
          }
          if (seg.type === 'subagent_start') {
            const displayName = seg.subagentName === 'sql-analyst'
              ? t('sqlAnalystWorking')
              : seg.subagentName === 'chart-builder'
              ? t('chartBuilderWorking')
              : `${seg.subagentName} working...`;
            return (
              <div key={i} className="message-bubble__subagent-indicator">
                <span className="message-bubble__subagent-label">{displayName}</span>
              </div>
            );
          }
          return null;
        })}
        {streamingRemainder?.trim() && (
          <div className="message-bubble__segment-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingRemainder}</ReactMarkdown>
          </div>
        )}
      </div>
    </details>
  );
}

export function MessageBubble({ message, messageIndex }: { message: ChatMessage; messageIndex: number }) {
  const { t } = useTranslation();
  const { isStreaming, editMessage, deleteMessage } = useAgent();
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(message.content);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isUser = message.role === 'user';
  const hasSegments = !isUser && message.segments && message.segments.length > 0;

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.selectionStart = textareaRef.current.value.length;
    }
  }, [isEditing]);

  const handleEdit = () => {
    setEditText(message.content);
    setIsEditing(true);
    setIsConfirmingDelete(false);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditText(message.content);
  };

  const handleSaveEdit = () => {
    const trimmed = editText.trim();
    if (!trimmed || trimmed === message.content) {
      handleCancelEdit();
      return;
    }
    setIsEditing(false);
    editMessage(messageIndex, trimmed);
  };

  const handleDeleteConfirm = () => {
    setIsConfirmingDelete(false);
    deleteMessage(messageIndex);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      handleCancelEdit();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSaveEdit();
    }
  };

  let streamingRemainder: string | undefined;
  if (hasSegments && message.isStreaming && message.content) {
    const segmentedText = message.segments!
      .filter((s) => s.type === 'thinking' || s.type === 'answer')
      .map((s) => s.text || '')
      .join('');
    const remaining = message.content.slice(segmentedText.length);
    if (remaining.trim()) {
      streamingRemainder = remaining;
    }
  }

  const hasAnswer = hasSegments && message.segments!.some((s) => s.type === 'answer');
  const isInAnswerPhase = message.currentPhase === 'answer';
  const isThinkingPhase = !!message.isStreaming && !hasAnswer && !isInAnswerPhase;

  const hasCharts = hasSegments && message.segments!.some(
    (s) => (s.type === 'tool' && s.toolResult?.chart_spec) || (s.type === 'subagent_end' && s.chart_spec)
  );

  const answerSegments = hasSegments
    ? message.segments!
        .filter((s) =>
          (s.type === 'answer' && s.text?.trim()) ||
          (s.type === 'subagent_end' && !s.chart_spec && s.text?.trim())
        )
        .map((s) => hasCharts ? { ...s, text: stripChartSpecBlocks(s.text!) } : s)
        .filter((s) => s.text?.trim())
    : [];

  const chartSegments = hasSegments
    ? message.segments!.filter(
        (s) =>
          (s.type === 'tool' && s.toolResult?.chart_spec) ||
          (s.type === 'subagent_end' && s.chart_spec)
      )
    : [];

  const questionSegments = hasSegments
    ? message.segments!.filter((s) => s.type === 'user_question' && s.questionData)
    : [];

  return (
    <div className={`message-bubble message-bubble--${message.role}`}>
      <div className="message-bubble__header">
        {isUser ? t('you') : t('assistant')}
        {isUser && !isStreaming && !isEditing && !isConfirmingDelete && (
          <span className="message-bubble__actions">
            <button
              className="message-bubble__action-btn"
              onClick={handleEdit}
              title={t('editMessage')}
            >
              &#9998;
            </button>
            <button
              className="message-bubble__action-btn message-bubble__action-btn--delete"
              onClick={() => setIsConfirmingDelete(true)}
              title={t('deleteMessage')}
            >
              &#128465;
            </button>
          </span>
        )}
      </div>

      {isUser && isConfirmingDelete && (
        <div className="message-bubble__confirm-delete">
          <span>{t('deleteConfirm')}</span>
          <div className="message-bubble__confirm-actions">
            <button
              className="message-bubble__confirm-btn message-bubble__confirm-btn--delete"
              onClick={handleDeleteConfirm}
            >
              {t('delete')}
            </button>
            <button
              className="message-bubble__confirm-btn"
              onClick={() => setIsConfirmingDelete(false)}
            >
              {t('cancel')}
            </button>
          </div>
        </div>
      )}

      {isUser && isEditing ? (
        <div className="message-bubble__edit-mode">
          <textarea
            ref={textareaRef}
            className="message-bubble__edit-textarea"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={3}
          />
          <div className="message-bubble__edit-actions">
            <button
              className="message-bubble__edit-btn message-bubble__edit-btn--save"
              onClick={handleSaveEdit}
            >
              {t('saveResend')}
            </button>
            <button
              className="message-bubble__edit-btn"
              onClick={handleCancelEdit}
            >
              {t('cancel')}
            </button>
          </div>
        </div>
      ) : hasSegments ? (
        <div className="message-bubble__segments">
          {!questionSegments.some((s) => !s.userAnswer) && (
            <ThinkingBlock
              segments={message.segments!}
              streamingRemainder={isThinkingPhase ? streamingRemainder : undefined}
              isThinkingPhase={isThinkingPhase}
              isAgentStreaming={!!message.isStreaming}
            />
          )}
          {questionSegments.map((seg, i) => (
            <div key={`question-${i}`} className="message-bubble__segment message-bubble__segment--question">
              <UserQuestion
                questionData={seg.questionData!}
                userAnswer={seg.userAnswer}
                userFreeText={seg.userFreeText}
              />
            </div>
          ))}
          {(chartSegments.length > 0 || answerSegments.length > 0) && (
            <div className="message-bubble__segment message-bubble__segment--answer">
              <div className="message-bubble__segment-label message-bubble__segment-label--answer">{t('answer')}</div>
              {chartSegments.map((seg, i) => (
                <div key={`chart-${i}`} className="message-bubble__chart-in-answer">
                  {seg.type === 'tool' && seg.toolResult ? (
                    <InlineQueryResult result={seg.toolResult!} />
                  ) : seg.chart_spec ? (
                    <ChartWidget data={seg.chart_spec.data} layout={seg.chart_spec.layout} frames={seg.chart_spec.frames} />
                  ) : null}
                </div>
              ))}
              {answerSegments.map((seg, i) => (
                <div key={`answer-${i}`} className="message-bubble__segment-content">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{seg.text!}</ReactMarkdown>
                </div>
              ))}
            </div>
          )}
          {isInAnswerPhase && streamingRemainder?.trim() && (() => {
            const displayText = hasCharts ? stripChartSpecBlocks(streamingRemainder) : streamingRemainder;
            return displayText?.trim() ? (
              <div className="message-bubble__segment message-bubble__segment--answer">
                <div className="message-bubble__segment-label message-bubble__segment-label--answer">{t('answer')}</div>
                <div className="message-bubble__segment-content">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayText}</ReactMarkdown>
                </div>
              </div>
            ) : null;
          })()}
          {message.isStreaming && !message.content && questionSegments.length === 0 && (
            <span className="message-bubble__typing">{t('thinking')}</span>
          )}
        </div>
      ) : (
        <>
          <div className="message-bubble__content">
            {message.content ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
            ) : message.isStreaming ? (
              <span className="message-bubble__typing">{t('thinking')}</span>
            ) : null}
          </div>
          {message.toolCalls && message.toolCalls.length > 0 && (
            <div className="message-bubble__tools">
              {message.toolCalls.map((tc) => (
                <InlineQueryResult key={tc.toolCallId} result={tc} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
