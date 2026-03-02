import type { ChatMessage, ContentSegment, UserQuestionData, UserQuestionOption } from '../types';

interface BackendMessage {
  id: string;
  role: string;
  content: string;
  metadata: string | null;
}

/**
 * Convert backend message objects into ChatMessage[] for the UI.
 * Shared by ConversationContext.selectConversation and AgentContext stale-onDone refresh.
 */
export function buildChatMessages(messages: BackendMessage[]): ChatMessage[] {
  return messages.map((msg) => {
    if (msg.role !== 'assistant') {
      return { id: msg.id, role: 'user' as const, content: msg.content };
    }

    // Try to restore segments from metadata
    let segments: ContentSegment[] | undefined;
    let durationMs: number | undefined;
    if (msg.metadata) {
      try {
        const meta = typeof msg.metadata === 'string' ? JSON.parse(msg.metadata) : msg.metadata;
        if (typeof meta?.durationMs === 'number') durationMs = meta.durationMs;
        if (Array.isArray(meta?.segments)) {
          segments = (meta.segments as Array<Record<string, unknown>>).map((seg) => {
            const s: ContentSegment = { type: seg.type as ContentSegment['type'] };
            if (seg.text) s.text = seg.text as string;
            if ((seg.toolCallId || seg.toolName) && seg.type !== 'user_question') {
              s.toolResult = {
                toolCallId: (seg.toolCallId as string) || '',
                toolName: seg.toolName as string,
                sql: (seg.sql as string) || '',
                columns: (Array.isArray(seg.columns) ? seg.columns : []) as string[],
                rows: (Array.isArray(seg.rows) ? seg.rows : []) as Record<string, unknown>[],
                rowCount: (seg.rowCount as number) || 0,
                error: seg.error as string | undefined,
                chart_spec: seg.chart_spec as ContentSegment['chart_spec'],
                ...(seg.toolInput ? { toolInput: seg.toolInput as Record<string, unknown> } : {}),
                ...(seg.output ? { output: seg.output as string } : {}),
              };
            }
            if (seg.subagentId) s.subagentId = seg.subagentId as string;
            if (seg.subagentName) s.subagentName = seg.subagentName as string;
            if (seg.sqlResults) s.sqlResults = seg.sqlResults as ContentSegment['sqlResults'];
            if (seg.chart_spec && seg.type === 'subagent_end') {
              s.chart_spec = seg.chart_spec as ContentSegment['chart_spec'];
            }
            if (seg.questionData && seg.type === 'user_question') {
              const qd = seg.questionData as Record<string, unknown>;
              s.questionData = {
                questionId: (qd.questionId as string) || '',
                question: (qd.question as string) || '',
                options: (Array.isArray(qd.options) ? qd.options : []) as UserQuestionOption[],
                multiSelect: (qd.multiSelect as boolean) || false,
              } as UserQuestionData;
              if (seg.userAnswer) s.userAnswer = seg.userAnswer as string[];
              if (seg.userFreeText) s.userFreeText = seg.userFreeText as string;
              if (seg.answerDurationMs) s.answerDurationMs = seg.answerDurationMs as number;
            }
            return s;
          });
        }
      } catch {
        // metadata parse failed, fall through to default
      }
    }

    // Fallback: single answer segment from content
    if (!segments) {
      segments = [{ type: 'answer' as const, text: msg.content }];
    }

    return {
      id: msg.id,
      role: 'assistant' as const,
      content: msg.content,
      segments,
      ...(durationMs != null && { durationMs }),
    };
  });
}
