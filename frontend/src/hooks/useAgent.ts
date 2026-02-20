import { createContext, useContext } from 'react';
import type { ChatMessage } from '../types';

interface AgentContextValue {
  messages: ChatMessage[];
  isStreaming: boolean;
  sendMessage: (text: string) => void;
  editMessage: (messageIndex: number, newContent: string) => void;
  deleteMessage: (messageIndex: number) => void;
  clearMessages: () => void;
}

export const AgentContext = createContext<AgentContextValue>({
  messages: [],
  isStreaming: false,
  sendMessage: () => {},
  editMessage: () => {},
  deleteMessage: () => {},
  clearMessages: () => {},
});

export function useAgent() {
  return useContext(AgentContext);
}
