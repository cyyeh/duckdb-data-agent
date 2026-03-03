import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from '../hooks/useTranslation';
import type { ChatMessage, ContentSegment } from '../types';
import { useAgent } from '../hooks/useAgent';
import { InlineQueryResult } from './InlineQueryResult';
import { ChartWidget } from './ChartWidget';
import { VegaLiteChartWidget } from './VegaLiteChartWidget';
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

/**
 * Fix missing line breaks before bold section headers in text.
 * The model sometimes concatenates bold headers directly after the previous
 * sentence (e.g. "...for arrays.**Preparing data arrays**"). This inserts
 * paragraph breaks so they render on new lines.
 */
function fixBoldHeaderLineBreaks(text: string): string {
  // Insert \n\n before **Header** when preceded by sentence-ending punctuation
  // with no whitespace. The [A-Z] ensures we only match section-header-style
  // bold (starting with a capital letter), avoiding inline bold like **data**.
  return text.replace(/([.!?:])(\*\*[A-Z])/g, '$1\n\n$2');
}

/** Strip markdown formatting for plain-text preview display. */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')   // **bold**
    .replace(/__(.+?)__/g, '$1')        // __bold__
    .replace(/\*(.+?)\*/g, '$1')        // *italic*
    .replace(/_(.+?)_/g, '$1')          // _italic_
    .replace(/`(.+?)`/g, '$1')          // `code`
    .replace(/^#+\s+/gm, '');           // # headings
}

function getLastThinkingLine(segments: ContentSegment[], streamingRemainder: string | undefined, t: (key: string) => string): string {
  // Use streaming remainder if available
  if (streamingRemainder?.trim()) {
    const lines = streamingRemainder.trim().split('\n').filter((l) => l.trim());
    const last = stripMarkdown(lines[lines.length - 1] || '');
    return last.length > 100 ? last.slice(0, 100) + '...' : last;
  }
  // Otherwise use last thinking segment's last line
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].type === 'thinking' && segments[i].text?.trim()) {
      const lines = segments[i].text!.trim().split('\n').filter((l) => l.trim());
      const last = stripMarkdown(lines[lines.length - 1] || '');
      return last.length > 100 ? last.slice(0, 100) + '...' : last;
    }
  }
  return t('thinking');
}

function ThinkingBlock({ segments, streamingRemainder, isThinkingPhase, isAgentStreaming, hasAnswer }: {
  segments: ContentSegment[];
  streamingRemainder?: string;
  isThinkingPhase: boolean;
  isAgentStreaming: boolean;
  hasAnswer: boolean;
}) {
  const { t } = useTranslation();
  // All non-answer, non-chart, non-user_question segments go inside the thinking block.
  // subagent_end with sqlResults always stays in thinking; text-only subagent_end without
  // answer goes to the answer block as a preliminary result.
  // subagent_end segments that have a matching subagent_start are grouped into the start block.
  const subagentStartIds = new Set(
    segments.filter(s => s.type === 'subagent_start').map(s => s.subagentId)
  );
  const thinkingSegments = segments.filter(
    (s) => s.type !== 'answer' && s.type !== 'user_question' && !(s.type === 'tool' && s.toolResult?.chart_spec) && !(s.type === 'subagent_end' && (s.chart_spec || (!s.sqlResults?.length && s.text?.trim() && !hasAnswer))) && !(s.type === 'subagent_end' && s.subagentId && subagentStartIds.has(s.subagentId))
  );
  const hasContent = thinkingSegments.some(
    (s) => (s.type === 'thinking' && s.text?.trim()) || (s.type === 'tool' && s.toolResult) || s.type === 'subagent_start' || (s.type === 'subagent_end' && !s.chart_spec && (s.text?.trim() || s.sqlResults?.length))
  ) || streamingRemainder?.trim();

  if (!hasContent) return null;

  // Show preview only while agent is still working (hidden by CSS when collapsible is open anyway)
  const summary = isAgentStreaming ? getLastThinkingLine(segments, streamingRemainder, t) : '';

  return (
    <details className="message-bubble__segment message-bubble__segment--thinking message-bubble__collapsible" open={isThinkingPhase || (!hasAnswer && !isAgentStreaming) || undefined}>
      <summary className="message-bubble__collapsible-summary">
        <span className="message-bubble__segment-label">{t('thinkingLabel')}</span>
        {summary && <span className="message-bubble__collapsible-preview">{summary}</span>}
      </summary>
      <div className="message-bubble__thinking-body">
        {thinkingSegments.map((seg, i) => {
          if (seg.type === 'thinking' && seg.text?.trim()) {
            return (
              <div key={i} className="message-bubble__segment-content">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{fixBoldHeaderLineBreaks(seg.text)}</ReactMarkdown>
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
            // Find matching subagent_end to group together
            const matchingEnd = segments.find(
              s => s.type === 'subagent_end' && s.subagentId === seg.subagentId && !s.chart_spec
            );
            const isCompleted = !!matchingEnd;
            const displayName = seg.subagentName === 'sql-analyst'
              ? t('sqlAnalystWorking')
              : `${seg.subagentName} working...`;
            // Combine thinking from both start (real-time) and end (final)
            const combinedThinking = [seg.thinking, matchingEnd?.thinking].filter(Boolean).join('\n').trim();
            const hasSqlContent = !!(seg.sqlProgress?.length || matchingEnd?.sqlResults?.length);
            const sqlCount = (seg.sqlProgress?.length ?? 0) + (matchingEnd?.sqlResults?.length ?? 0);
            return (
              <div key={i}>
                <div className="message-bubble__subagent-indicator">
                  <span className="message-bubble__subagent-label">{displayName}</span>
                </div>
                {combinedThinking && (
                  <div className="message-bubble__subagent-thinking">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{combinedThinking}</ReactMarkdown>
                  </div>
                )}
                {hasSqlContent && (
                  <details className="message-bubble__subagent-sql-group" open={!isCompleted || undefined}>
                    <summary className="message-bubble__subagent-sql-summary">
                      {t(sqlCount === 1 ? 'subagentQueryCount' : 'subagentQueryCountPlural', { count: sqlCount })}
                    </summary>
                    <div className="message-bubble__subagent-sql-body">
                      {/* Real-time SQL progress (shown while subagent is running) */}
                      {seg.sqlProgress?.map((entry, qi) => (
                        <div key={`progress-${qi}`} className="message-bubble__tool-segment">
                          <InlineQueryResult result={{
                            toolCallId: `${seg.subagentId}-progress-${qi}`,
                            toolName: 'execute_sql',
                            sql: entry.sql,
                            columns: entry.status === 'executing' ? [] : (entry.columns ?? []),
                            rows: entry.status === 'executing' ? [] : (entry.rows ?? []),
                            rowCount: entry.status === 'executing' ? 0 : (entry.rowCount ?? 0),
                            error: entry.error,
                          }} />
                        </div>
                      ))}
                      {/* Final SQL results from subagent_end (shown after completion) */}
                      {matchingEnd?.sqlResults?.map((sqlResult, qi) => (
                        <div key={`result-${qi}`} className="message-bubble__tool-segment">
                          <InlineQueryResult result={{
                            toolCallId: `${seg.subagentId}-sql-${qi}`,
                            toolName: 'execute_sql',
                            sql: sqlResult.sql,
                            columns: sqlResult.columns ?? [],
                            rows: sqlResult.rows ?? [],
                            rowCount: sqlResult.rowCount ?? 0,
                            error: sqlResult.error,
                          }} />
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            );
          }
          if (seg.type === 'subagent_end' && !seg.chart_spec && (seg.sqlResults?.length || seg.text?.trim() || seg.thinking?.trim())) {
            return (
              <div key={i}>
                {seg.thinking?.trim() && (
                  <div className="message-bubble__subagent-thinking">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{seg.thinking}</ReactMarkdown>
                  </div>
                )}
                {seg.sqlResults?.length ? (
                  seg.sqlResults.map((sqlResult, qi) => (
                    <div key={qi} className="message-bubble__tool-segment">
                      <InlineQueryResult result={{
                        toolCallId: `${seg.subagentId}-sql-${qi}`,
                        toolName: 'execute_sql',
                        sql: sqlResult.sql,
                        columns: sqlResult.columns ?? [],
                        rows: sqlResult.rows ?? [],
                        rowCount: sqlResult.rowCount ?? 0,
                        error: sqlResult.error,
                      }} />
                    </div>
                  ))
                ) : seg.text?.trim() ? (
                  <div className="message-bubble__segment-content">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{seg.text!}</ReactMarkdown>
                  </div>
                ) : null}
              </div>
            );
          }
          return null;
        })}
        {streamingRemainder?.trim() && (
          <div className="message-bubble__segment-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{fixBoldHeaderLineBreaks(streamingRemainder)}</ReactMarkdown>
          </div>
        )}
      </div>
    </details>
  );
}

function ErrorBlock({ errorMessage, onRetry }: { errorMessage: string; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="message-bubble__segment message-bubble__segment--error">
      <div className="message-bubble__error-header">{t('errorOccurred')}</div>
      <div className="message-bubble__error-message">{errorMessage}</div>
      {onRetry && (
        <button className="message-bubble__error-retry" onClick={onRetry}>
          {t('tryAgain')}
        </button>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

export function MessageBubble({ message, messageIndex }: { message: ChatMessage; messageIndex: number }) {
  const { t } = useTranslation();
  const { isStreaming, editMessage, deleteMessage, sendMessage, messages } = useAgent();
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

  const hasAnswer = !!hasSegments && message.segments!.some((s) => s.type === 'answer');
  const isInAnswerPhase = message.currentPhase === 'answer';
  const isThinkingPhase = !!message.isStreaming && !hasAnswer && !isInAnswerPhase;

  const hasCharts = hasSegments && message.segments!.some(
    (s) => (s.type === 'tool' && s.toolResult?.chart_spec) || (s.type === 'subagent_end' && s.chart_spec)
  );

  const answerBlockSegments = hasSegments
    ? message.segments!
        .filter((s) =>
          (s.type === 'answer' && s.text?.trim()) ||
          (s.type === 'subagent_end' && !s.chart_spec && !s.sqlResults?.length && s.text?.trim() && !hasAnswer) ||
          (s.type === 'tool' && s.toolResult?.chart_spec) ||
          (s.type === 'subagent_end' && s.chart_spec)
        )
        .map((s) => {
          if ((s.type === 'answer' || (s.type === 'subagent_end' && !s.chart_spec)) && s.text && hasCharts) {
            return { ...s, text: stripChartSpecBlocks(s.text) };
          }
          return s;
        })
        .filter((s) => {
          // Remove text segments that became empty after stripping chart blocks
          if ((s.type === 'answer' || (s.type === 'subagent_end' && !s.chart_spec)) && !s.text?.trim()) {
            return false;
          }
          return true;
        })
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
              hasAnswer={hasAnswer}
            />
          )}
          {questionSegments.map((seg, i) => (
            <div key={`question-${i}`} className="message-bubble__segment message-bubble__segment--question">
              <UserQuestion
                questionData={seg.questionData!}
                userAnswer={seg.userAnswer}
                userFreeText={seg.userFreeText}
                answerDurationMs={seg.answerDurationMs}
              />
            </div>
          ))}
          {answerBlockSegments.length > 0 && (
            <div className="message-bubble__segment message-bubble__segment--answer">
              <div className="message-bubble__segment-label message-bubble__segment-label--answer">{t('answer')}</div>
              {answerBlockSegments.map((seg, i) => {
                // Chart segment (tool with chart_spec or subagent_end with chart_spec)
                if ((seg.type === 'tool' && seg.toolResult?.chart_spec) || (seg.type === 'subagent_end' && seg.chart_spec)) {
                  return (
                    <div key={`chart-${i}`} className="message-bubble__chart-in-answer">
                      {seg.type === 'tool' && seg.toolResult ? (
                        <InlineQueryResult result={seg.toolResult!} />
                      ) : seg.chart_spec ? (
                        seg.chart_spec.library === 'vegalite' && seg.chart_spec.spec
                          ? <VegaLiteChartWidget spec={seg.chart_spec.spec} />
                          : <ChartWidget data={seg.chart_spec.data ?? []} layout={seg.chart_spec.layout} frames={seg.chart_spec.frames} />
                      ) : null}
                    </div>
                  );
                }
                // Text segment (answer or subagent_end without chart_spec)
                return (
                  <div key={`answer-${i}`} className="message-bubble__segment-content">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{fixBoldHeaderLineBreaks(seg.text!)}</ReactMarkdown>
                  </div>
                );
              })}
              {/* Render streaming remainder inside the same answer block to avoid duplicate headers */}
              {isInAnswerPhase && streamingRemainder?.trim() && (() => {
                const displayText = hasCharts ? stripChartSpecBlocks(streamingRemainder) : streamingRemainder;
                return displayText?.trim() ? (
                  <div className="message-bubble__segment-content">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{fixBoldHeaderLineBreaks(displayText)}</ReactMarkdown>
                  </div>
                ) : null;
              })()}
              {!message.isStreaming && message.durationMs != null && (
                <div className="message-bubble__duration">
                  {t('answeredIn', { time: formatDuration(message.durationMs) })}
                </div>
              )}
            </div>
          )}
          {/* Only show standalone streaming answer block when no answer segments exist yet */}
          {answerBlockSegments.length === 0 && isInAnswerPhase && streamingRemainder?.trim() && (() => {
            const displayText = hasCharts ? stripChartSpecBlocks(streamingRemainder) : streamingRemainder;
            return displayText?.trim() ? (
              <div className="message-bubble__segment message-bubble__segment--answer">
                <div className="message-bubble__segment-label message-bubble__segment-label--answer">{t('answer')}</div>
                <div className="message-bubble__segment-content">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{fixBoldHeaderLineBreaks(displayText)}</ReactMarkdown>
                </div>
              </div>
            ) : null;
          })()}
          {message.segments!.filter((s) => s.type === 'error').map((seg, i) => {
            const lastUserMsg = messages.slice().reverse().find((m) => m.role === 'user');
            const handleRetry = lastUserMsg ? () => sendMessage(lastUserMsg.content) : undefined;
            return <ErrorBlock key={`error-${i}`} errorMessage={seg.errorMessage || 'Unknown error'} onRetry={!isStreaming ? handleRetry : undefined} />;
          })}
          {message.isStreaming && !message.content && questionSegments.length === 0 && (
            <span className="message-bubble__typing">{t('thinking')}</span>
          )}
        </div>
      ) : (
        <>
          <div className="message-bubble__content">
            {message.content ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{fixBoldHeaderLineBreaks(message.content)}</ReactMarkdown>
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
