import { createContext, useState, useCallback, useContext, ReactNode } from 'react';
import type { ChatMessage } from '../types';

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

export function ConversationProvider({ children }: { children: ReactNode }) {
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const triggerRefresh = useCallback(() => {
    setRefreshTrigger((n) => n + 1);
  }, []);

  const createConversation = useCallback(async (firstMessage: string): Promise<string> => {
    const title = firstMessage.length > 50 ? firstMessage.slice(0, 50) + '...' : firstMessage;
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    const conv = await res.json();
    setActiveConversationId(conv.id);
    triggerRefresh();
    return conv.id;
  }, [triggerRefresh]);

  const selectConversation = useCallback(async (id: string): Promise<ChatMessage[]> => {
    const res = await fetch(`/api/conversations/${id}`);
    if (!res.ok) throw new Error('Failed to load conversation');
    const conv: Conversation = await res.json();
    setActiveConversationId(id);

    const chatMessages: ChatMessage[] = (conv.messages || []).map((msg) => ({
      id: msg.id,
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
      segments: msg.role === 'assistant' ? [{ type: 'answer' as const, text: msg.content }] : undefined,
    }));
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
