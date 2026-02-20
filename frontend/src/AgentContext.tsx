import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { runAgentLoop } from './agent/agentService';
import type { ChatMessage, ContentSegment, TableInfo, ToolCallResult } from './types';

interface AgentContextValue {
  messages: ChatMessage[];
  isStreaming: boolean;
  sendMessage: (text: string) => void;
  clearMessages: () => void;
}

const AgentContext = createContext<AgentContextValue>({
  messages: [],
  isStreaming: false,
  sendMessage: () => {},
  clearMessages: () => {},
});

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

export function AgentProvider({
  children,
  refreshTables,
}: {
  children: ReactNode;
  tables: TableInfo[];
  refreshTables: () => Promise<void>;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const textBufferRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const assistantIdRef = useRef('');
  const segmentsRef = useRef<ContentSegment[]>([]);
  const currentTextRef = useRef('');
  const sessionIdRef = useRef<string | null>(null);

  const flushText = useCallback(() => {
    const text = textBufferRef.current;
    if (!text) return;
    const id = assistantIdRef.current;
    currentTextRef.current += text;
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id ? { ...m, content: m.content + text } : m
      )
    );
    textBufferRef.current = '';
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      if (isStreaming) return;

      const userMsg: ChatMessage = {
        id: generateId(),
        role: 'user',
        content: text,
      };

      const assistantId = generateId();
      assistantIdRef.current = assistantId;
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        toolCalls: [],
        isStreaming: true,
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);
      textBufferRef.current = '';
      segmentsRef.current = [];
      currentTextRef.current = '';

      const controller = new AbortController();
      abortRef.current = controller;

      await runAgentLoop(
        text,
        sessionIdRef.current,
        {
          onTextChunk: (chunk) => {
            textBufferRef.current += chunk;
            if (!flushTimerRef.current) {
              flushTimerRef.current = setTimeout(() => {
                flushText();
                flushTimerRef.current = null;
              }, 50);
            }
          },
          onThinkingDone: () => {
            // Extended thinking just ended and a text block is starting.
            // Create a thinking segment from accumulated thinking text.
            if (flushTimerRef.current) {
              clearTimeout(flushTimerRef.current);
              flushTimerRef.current = null;
            }
            flushText();
            if (currentTextRef.current.trim()) {
              segmentsRef.current.push({ type: 'thinking', text: currentTextRef.current });
              currentTextRef.current = '';
            }
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, currentPhase: 'answer', segments: [...segmentsRef.current] }
                  : m
              )
            );
          },
          onToolCall: (pending: ToolCallResult) => {
            if (flushTimerRef.current) {
              clearTimeout(flushTimerRef.current);
              flushTimerRef.current = null;
            }
            flushText();
            if (currentTextRef.current.trim()) {
              segmentsRef.current.push({ type: 'thinking', text: currentTextRef.current });
              currentTextRef.current = '';
            }
            // Add a pending tool segment so the input is shown immediately
            segmentsRef.current.push({
              type: 'tool',
              toolResult: pending,
            });
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, segments: [...segmentsRef.current] }
                  : m
              )
            );
          },
          onToolResult: (result: ToolCallResult) => {
            // Merge result into pending tool segment (keep input info, add output)
            const pendingIdx = segmentsRef.current.findIndex(
              (s) => s.type === 'tool' && s.toolResult?.toolCallId === result.toolCallId
            );
            if (pendingIdx !== -1) {
              const pending = segmentsRef.current[pendingIdx].toolResult!;
              segmentsRef.current[pendingIdx] = {
                type: 'tool',
                toolResult: {
                  ...pending,
                  ...result,
                  toolName: result.toolName || pending.toolName,
                  command: result.command || pending.command,
                  toolInput: result.toolInput || pending.toolInput,
                },
              };
            } else {
              segmentsRef.current.push({ type: 'tool', toolResult: result });
            }
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, toolCalls: [...(m.toolCalls || []), result], segments: [...segmentsRef.current] }
                  : m
              )
            );
            refreshTables();
          },
          onDone: (newSessionId) => {
            if (newSessionId) sessionIdRef.current = newSessionId;
            if (flushTimerRef.current) {
              clearTimeout(flushTimerRef.current);
              flushTimerRef.current = null;
            }
            flushText();
            if (currentTextRef.current.trim()) {
              segmentsRef.current.push({
                type: 'answer',
                text: currentTextRef.current,
              });
              currentTextRef.current = '';
            }
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, isStreaming: false, currentPhase: undefined, segments: [...segmentsRef.current] }
                  : m
              )
            );
            setIsStreaming(false);
            abortRef.current = null;
          },
          onError: (error) => {
            if (flushTimerRef.current) {
              clearTimeout(flushTimerRef.current);
              flushTimerRef.current = null;
            }
            flushText();
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, content: m.content + `\n\n**Error:** ${error}`, isStreaming: false }
                  : m
              )
            );
            setIsStreaming(false);
            abortRef.current = null;
          },
        },
        controller.signal
      );
    },
    [isStreaming, messages, flushText, refreshTables]
  );

  const clearMessages = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    setMessages([]);
    setIsStreaming(false);
    sessionIdRef.current = null;
  }, []);

  return (
    <AgentContext.Provider
      value={{ messages, isStreaming, sendMessage, clearMessages }}
    >
      {children}
    </AgentContext.Provider>
  );
}

export function useAgent() {
  return useContext(AgentContext);
}
