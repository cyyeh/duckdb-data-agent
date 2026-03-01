import { createContext, useState, useCallback, useContext, ReactNode } from 'react';
import type { ChatMessage, ContentSegment } from '../types';

interface Conversation {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  messages?: Array<{
    id: string;
    role: string;
    content: string;
    metadata: string | null;
    sort_order: number;
  }>;
}

interface ConversationContextType {
  activeConversationId: string | null;
  refreshTrigger: number;
  createConversation: (firstMessage: string) => Promise<string>;
  selectConversation: (id: string) => Promise<ChatMessage[]>;
  deleteConversation: (id: string) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  startNewConversation: () => void;
  triggerRefresh: () => void;
}

const ConversationContext = createContext<ConversationContextType | null>(null);

export function ConversationProvider({ children, sessionId }: { children: ReactNode; sessionId: string }) {
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const triggerRefresh = useCallback(() => {
    setRefreshTrigger((n) => n + 1);
  }, []);

  const createConversation = useCallback(async (firstMessage: string): Promise<string> => {
    const title = firstMessage.length > 50 ? firstMessage.slice(0, 50) + '...' : firstMessage;
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-ID': sessionId },
      body: JSON.stringify({ title }),
    });
    const conv = await res.json();
    setActiveConversationId(conv.id);
    triggerRefresh();
    return conv.id;
  }, [triggerRefresh, sessionId]);

  const selectConversation = useCallback(async (id: string): Promise<ChatMessage[]> => {
    const res = await fetch(`/api/conversations/${id}`);
    if (!res.ok) throw new Error('Failed to load conversation');
    const conv: Conversation = await res.json();
    setActiveConversationId(id);

    const chatMessages: ChatMessage[] = (conv.messages || []).map((msg) => {
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
    return chatMessages;
  }, []);

  const deleteConversation = useCallback(async (id: string) => {
    await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
    if (activeConversationId === id) {
      setActiveConversationId(null);
    }
    triggerRefresh();
  }, [activeConversationId, triggerRefresh]);

  const renameConversation = useCallback(async (id: string, title: string) => {
    await fetch(`/api/conversations/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    triggerRefresh();
  }, [triggerRefresh]);

  const startNewConversation = useCallback(() => {
    setActiveConversationId(null);
  }, []);

  return (
    <ConversationContext.Provider
      value={{
        activeConversationId,
        refreshTrigger,
        createConversation,
        selectConversation,
        deleteConversation,
        renameConversation,
        startNewConversation,
        triggerRefresh,
      }}
    >
      {children}
    </ConversationContext.Provider>
  );
}

export function useConversation() {
  const ctx = useContext(ConversationContext);
  if (!ctx) throw new Error('useConversation must be used within ConversationProvider');
  return ctx;
}
