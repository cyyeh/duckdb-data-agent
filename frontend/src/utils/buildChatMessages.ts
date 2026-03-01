import type { ChatMessage, ContentSegment } from '../types';

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
    if (msg.metadata) {
      try {
        const meta = typeof msg.metadata === 'string' ? JSON.parse(msg.metadata) : msg.metadata;
        if (Array.isArray(meta?.segments)) {
          segments = (meta.segments as Array<Record<string, unknown>>).map((seg) => {
            const s: ContentSegment = { type: seg.type as ContentSegment['type'] };
            if (seg.text) s.text = seg.text as string;
            if (seg.toolCallId || seg.toolName) {
              s.toolResult = {
                toolCallId: (seg.toolCallId as string) || '',
                toolName: seg.toolName as string,
                sql: (seg.sql as string) || '',
                columns: [],
                rows: [],
                rowCount: (seg.rowCount as number) || 0,
                error: seg.error as string | undefined,
                chart_spec: seg.chart_spec as ContentSegment['chart_spec'],
              };
            }
            if (seg.subagentId) s.subagentId = seg.subagentId as string;
            if (seg.subagentName) s.subagentName = seg.subagentName as string;
            if (seg.sqlResults) s.sqlResults = seg.sqlResults as ContentSegment['sqlResults'];
            if (seg.chart_spec && seg.type === 'subagent_end') {
              s.chart_spec = seg.chart_spec as ContentSegment['chart_spec'];
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
    };
  });
}
