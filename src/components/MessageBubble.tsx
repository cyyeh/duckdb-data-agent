import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage, ContentSegment } from '../types';
import { InlineQueryResult } from './InlineQueryResult';
import './MessageBubble.css';

function getLastThinkingLine(segments: ContentSegment[], streamingRemainder?: string): string {
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
  return 'Thinking...';
}

function ThinkingBlock({ segments, streamingRemainder, isActivelyStreaming }: {
  segments: ContentSegment[];
  streamingRemainder?: string;
  isActivelyStreaming: boolean;
}) {
  // All non-answer segments go inside the thinking block
  const thinkingSegments = segments.filter((s) => s.type !== 'answer');
  const hasContent = thinkingSegments.some(
    (s) => (s.type === 'thinking' && s.text?.trim()) || (s.type === 'tool' && s.toolResult)
  ) || streamingRemainder?.trim();

  if (!hasContent) return null;

  const summary = getLastThinkingLine(segments, streamingRemainder);

  return (
    <details className="message-bubble__segment message-bubble__segment--thinking message-bubble__collapsible" open={isActivelyStreaming || undefined}>
      <summary className="message-bubble__collapsible-summary">
        <span className="message-bubble__segment-label">Thinking</span>
        <span className="message-bubble__collapsible-preview">{summary}</span>
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

export function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  const hasSegments = !isUser && message.segments && message.segments.length > 0;

  // Compute streaming remainder text
  let streamingRemainder: string | undefined;
  if (hasSegments && message.isStreaming && message.content) {
    const segmentedText = message.segments!
      .filter((s) => s.type !== 'tool')
      .map((s) => s.text || '')
      .join('');
    const remaining = message.content.slice(segmentedText.length);
    if (remaining.trim()) {
      streamingRemainder = remaining;
    }
  }

  // Check if currently in a thinking-only phase (no answer segment yet)
  const hasAnswer = hasSegments && message.segments!.some((s) => s.type === 'answer');
  const isThinkingPhase = !!message.isStreaming && !hasAnswer;

  // Extract answer segments
  const answerSegments = hasSegments
    ? message.segments!.filter((s) => s.type === 'answer' && s.text?.trim())
    : [];

  return (
    <div className={`message-bubble message-bubble--${message.role}`}>
      <div className="message-bubble__header">
        {isUser ? 'You' : 'Assistant'}
      </div>

      {hasSegments ? (
        <div className="message-bubble__segments">
          <ThinkingBlock
            segments={message.segments!}
            streamingRemainder={isThinkingPhase ? streamingRemainder : undefined}
            isActivelyStreaming={isThinkingPhase}
          />
          {answerSegments.map((seg, i) => (
            <div key={i} className="message-bubble__segment message-bubble__segment--answer">
              <div className="message-bubble__segment-label message-bubble__segment-label--answer">Answer</div>
              <div className="message-bubble__segment-content">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{seg.text!}</ReactMarkdown>
              </div>
            </div>
          ))}
          {message.isStreaming && !message.content && (
            <span className="message-bubble__typing">Thinking...</span>
          )}
        </div>
      ) : (
        <>
          <div className="message-bubble__content">
            {message.content ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
            ) : message.isStreaming ? (
              <span className="message-bubble__typing">Thinking...</span>
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
