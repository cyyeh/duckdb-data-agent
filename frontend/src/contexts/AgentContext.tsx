import {
  useCallback,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AgentContext } from '../hooks/useAgent';
import { runAgentLoop, runAgentEditLoop } from '../agent/agentService';
import type { ChatMessage, ContentSegment, ToolCallResult } from '../types';
import { useSessionId } from '../hooks/useSessionId';

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

export function AgentProvider({
  children,
  refreshTables,
}: {
  children: ReactNode;
  refreshTables: () => Promise<void>;
}) {
  const userSessionId = useSessionId();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const textBufferRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const assistantIdRef = useRef('');
  const segmentsRef = useRef<ContentSegment[]>([]);
  const currentTextRef = useRef('');
  const sessionIdRef = useRef<string | null>(null);
  const pendingHistoryRef = useRef<{ role: string; content: string }[] | null>(null);

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

      // If there's pending history from a delete, start a new Langfuse session with that context
      const pendingHistory = pendingHistoryRef.current;
      pendingHistoryRef.current = null;
      const langfuseSessionId = pendingHistory ? crypto.randomUUID() : null;

      const controller = new AbortController();
      abortRef.current = controller;

      await runAgentLoop(
        text,
        sessionIdRef.current,
        langfuseSessionId,
        pendingHistory,
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
                  sql: result.sql || pending.sql,
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
        controller.signal,
        userSessionId,
      );
    },
    [isStreaming, flushText, refreshTables, userSessionId]
  );

  const editMessage = useCallback(
    async (messageIndex: number, newContent: string) => {
      if (isStreaming) return;

      // Build conversation history from messages before the edit point
      const conversationHistory: { role: string; content: string }[] = [];
      for (let i = 0; i < messageIndex; i++) {
        const msg = messages[i];
        if (msg.role === 'user' || msg.role === 'assistant') {
          conversationHistory.push({ role: msg.role, content: msg.content });
        }
      }

      const assistantId = generateId();
      assistantIdRef.current = assistantId;

      const userMsg: ChatMessage = {
        id: generateId(),
        role: 'user',
        content: newContent,
      };
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        toolCalls: [],
        isStreaming: true,
      };

      setMessages((prev) => [...prev.slice(0, messageIndex), userMsg, assistantMsg]);
      setIsStreaming(true);
      textBufferRef.current = '';
      segmentsRef.current = [];
      currentTextRef.current = '';

      const controller = new AbortController();
      abortRef.current = controller;

      await runAgentEditLoop(
        newContent,
        conversationHistory,
        crypto.randomUUID(),
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
            segmentsRef.current.push({ type: 'tool', toolResult: pending });
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, segments: [...segmentsRef.current] }
                  : m
              )
            );
          },
          onToolResult: (result: ToolCallResult) => {
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
                  sql: result.sql || pending.sql,
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
              segmentsRef.current.push({ type: 'answer', text: currentTextRef.current });
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
        controller.signal,
        userSessionId,
      );
    },
    [isStreaming, messages, flushText, refreshTables, userSessionId]
  );

  const deleteMessage = useCallback(
    (messageIndex: number) => {
      if (isStreaming) return;

      // Store remaining messages as history for Langfuse context on next send
      setMessages((prev) => {
        const remaining = prev.slice(0, messageIndex);
        pendingHistoryRef.current = remaining
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role, content: m.content }));
        return remaining;
      });

      // Clear session so next message starts fresh
      sessionIdRef.current = null;
    },
    [isStreaming]
  );

  const clearMessages = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    setMessages([]);
    setIsStreaming(false);
    sessionIdRef.current = null;
    pendingHistoryRef.current = null;
  }, []);

  return (
    <AgentContext.Provider
      value={{ messages, isStreaming, sendMessage, editMessage, deleteMessage, clearMessages }}
    >
      {children}
    </AgentContext.Provider>
  );
}
