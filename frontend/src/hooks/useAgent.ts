import { createContext, useContext } from 'react';
import type { ChatMessage } from '../types';

interface AgentContextValue {
  messages: ChatMessage[];
  isStreaming: boolean;
  sendMessage: (text: string, conversationId?: string | null) => void;
  editMessage: (messageIndex: number, newContent: string) => void;
  deleteMessage: (messageIndex: number) => void;
  clearMessages: (outgoingConversationId?: string | null) => void;
  loadMessages: (msgs: ChatMessage[], outgoingConversationId?: string | null, incomingConversationId?: string | null) => void;
  respondToQuestion: (questionId: string, answers: string[], freeText?: string) => void;
}

export const AgentContext = createContext<AgentContextValue>({
  messages: [],
  isStreaming: false,
  sendMessage: () => {},
  editMessage: () => {},
  deleteMessage: () => {},
  clearMessages: () => {},
  loadMessages: () => {},
  respondToQuestion: () => {},
});

export function useAgent() {
  return useContext(AgentContext);
}
