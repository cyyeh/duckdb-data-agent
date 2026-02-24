import { createContext, useContext } from 'react';
import type { ChatMessage } from '../types';

interface AgentContextValue {
  messages: ChatMessage[];
  isStreaming: boolean;
  sendMessage: (text: string) => void;
  editMessage: (messageIndex: number, newContent: string) => void;
  deleteMessage: (messageIndex: number) => void;
  clearMessages: () => void;
  respondToQuestion: (questionId: string, answers: string[], freeText?: string) => void;
}

export const AgentContext = createContext<AgentContextValue>({
  messages: [],
  isStreaming: false,
  sendMessage: () => {},
  editMessage: () => {},
  deleteMessage: () => {},
  clearMessages: () => {},
  respondToQuestion: () => {},
});

export function useAgent() {
  return useContext(AgentContext);
}
