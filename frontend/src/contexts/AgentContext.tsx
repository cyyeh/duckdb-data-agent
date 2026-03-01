import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AgentContext } from '../hooks/useAgent';
import { runAgentLoop, runAgentEditLoop } from '../agent/agentService';
import type { ChatMessage, ContentSegment, ToolCallResult } from '../types';
import { useSessionId } from '../hooks/useSessionId';
import { generateUUID } from '../utils/uuid';

interface StreamState {
  assistantId: string;
  segments: ContentSegment[];
  currentText: string;
  textBuffer: string;
  phase: 'thinking' | 'answer';
  abortController: AbortController;
  sessionId: string | null;
  messages: ChatMessage[];
  flushTimer: ReturnType<typeof setTimeout> | null;
}

function generateId() {
  return generateUUID();
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
  const sessionIdRef = useRef<string | null>(null);
  const pendingHistoryRef = useRef<{ role: string; content: string }[] | null>(null);
  // Keep a ref in sync with messages so sendMessage always reads the latest
  const messagesRef = useRef<ChatMessage[]>(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  // Cache messages per conversation so switching away doesn't lose in-progress data
  const messagesCacheRef = useRef<Map<string, ChatMessage[]>>(new Map());
  // Track which conversation is currently displayed so background streams can detect they're stale
  const activeConversationIdRef = useRef<string | null>(null);

  // Per-conversation stream state map (replaces all singleton streaming refs)
  const streamStatesRef = useRef<Map<string, StreamState>>(new Map());
  const [streamingConversationIds, setStreamingConversationIds] = useState<Set<string>>(new Set());

  const flushTextForStream = useCallback((state: StreamState, conversationId: string | null) => {
    const text = state.textBuffer;
    if (!text) return;
    state.currentText += text;
    state.textBuffer = '';

    // Update the stream's own messages
    state.messages = state.messages.map((m) =>
      m.id === state.assistantId ? { ...m, content: m.content + text } : m
    );

    // If this conversation is currently being viewed, update React state
    if (activeConversationIdRef.current === conversationId) {
      setMessages(state.messages);
    }
  }, []);

  const sendMessage = useCallback(
    async (text: string, conversationId?: string | null) => {
      const convId = conversationId || null;
      // Per-conversation guard: don't double-send in same conversation
      if (convId && streamStatesRef.current.has(convId)) return;
      // Fallback guard for null-convId path (new chat before conversation created)
      if (!convId && isStreaming) return;

      const controller = new AbortController();
      const assistantId = generateId();

      const userMsg: ChatMessage = {
        id: generateId(),
        role: 'user',
        content: text,
      };
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        toolCalls: [],
        isStreaming: true,
      };

      // Build conversation history from current messages or cached messages
      const currentMsgs = convId && activeConversationIdRef.current === convId
        ? messagesRef.current
        : (convId ? messagesCacheRef.current.get(convId) : messagesRef.current) || messagesRef.current;
      const history = currentMsgs
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content }));

      const streamMessages = [...currentMsgs, userMsg, assistantMsg];

      // Create per-conversation stream state
      const state: StreamState = {
        assistantId,
        segments: [],
        currentText: '',
        textBuffer: '',
        phase: 'thinking',
        abortController: controller,
        sessionId: sessionIdRef.current,
        messages: streamMessages,
        flushTimer: null,
      };

      if (convId) {
        streamStatesRef.current.set(convId, state);
        setStreamingConversationIds(prev => new Set(prev).add(convId));
      }

      // Sync the ref when sending to a newly-created conversation whose ID
      // hasn't propagated through loadMessages/clearMessages yet.
      if (convId && activeConversationIdRef.current !== convId) {
        activeConversationIdRef.current = convId;
      }

      // If this is the active conversation, update React state
      if (activeConversationIdRef.current === convId) {
        setMessages(streamMessages);
        setIsStreaming(true);
      }

      // If there's pending history from a delete, start a new Langfuse session
      const pendingHistory = pendingHistoryRef.current;
      pendingHistoryRef.current = null;
      const langfuseSessionId = pendingHistory ? generateUUID() : null;

      // Extract skill references
      let actualMessage = text;
      let skills: string[] | undefined;
      const slashMatches = [...text.matchAll(/\/([a-z0-9-]+)/g)];
      if (slashMatches.length > 0) {
        skills = slashMatches.map((m) => m[1]);
        actualMessage = slashMatches.reduce((msg, m) => msg.replace(m[0], ''), text).trim() || text;
      }

      // Helper to update stream messages and optionally React state
      const updateMessages = (updater: (msgs: ChatMessage[]) => ChatMessage[]) => {
        state.messages = updater(state.messages);
        if (activeConversationIdRef.current === convId) {
          setMessages(state.messages);
        }
      };

      // Helper to schedule text flush
      const scheduleFlush = () => {
        if (!state.flushTimer) {
          state.flushTimer = setTimeout(() => {
            flushTextForStream(state, convId);
            state.flushTimer = null;
          }, 50);
        }
      };

      // Helper to flush pending text immediately
      const flushNow = () => {
        if (state.flushTimer) {
          clearTimeout(state.flushTimer);
          state.flushTimer = null;
        }
        flushTextForStream(state, convId);
      };

      // Helper to finalize stream (called by onDone and onError)
      const cleanupStream = () => {
        if (state.flushTimer) {
          clearTimeout(state.flushTimer);
          state.flushTimer = null;
        }
        if (convId) {
          streamStatesRef.current.delete(convId);
          setStreamingConversationIds(prev => {
            const next = new Set(prev);
            next.delete(convId);
            return next;
          });
        }
      };

      await runAgentLoop(
        actualMessage,
        state.sessionId,
        langfuseSessionId,
        pendingHistory ?? (history.length > 0 ? history : null),
        conversationId,
        {
          onTextChunk: (chunk) => {
            state.textBuffer += chunk;
            scheduleFlush();
          },
          onThinkingDone: () => {
            flushNow();
            if (state.currentText.trim()) {
              state.segments.push({ type: 'thinking', text: state.currentText });
              state.currentText = '';
            }
            state.phase = 'answer';
            updateMessages(msgs =>
              msgs.map(m =>
                m.id === assistantId
                  ? { ...m, currentPhase: 'answer', segments: [...state.segments] }
                  : m
              )
            );
          },
          onToolCall: (pending: ToolCallResult) => {
            flushNow();
            if (state.currentText.trim()) {
              const segType = state.phase === 'answer' ? 'answer' : 'thinking';
              state.segments.push({ type: segType, text: state.currentText });
              state.currentText = '';
            }
            state.segments.push({ type: 'tool', toolResult: pending });
            updateMessages(msgs =>
              msgs.map(m =>
                m.id === assistantId
                  ? { ...m, currentPhase: 'answer', segments: [...state.segments] }
                  : m
              )
            );
          },
          onToolResult: (result: ToolCallResult) => {
            const pendingIdx = state.segments.findIndex(
              s => s.type === 'tool' && s.toolResult?.toolCallId === result.toolCallId
            );
            if (pendingIdx !== -1) {
              const pending = state.segments[pendingIdx].toolResult!;
              state.segments[pendingIdx] = {
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
              state.segments.push({ type: 'tool', toolResult: result });
            }
            updateMessages(msgs =>
              msgs.map(m =>
                m.id === assistantId
                  ? { ...m, toolCalls: [...(m.toolCalls || []), result], segments: [...state.segments] }
                  : m
              )
            );
            refreshTables();
            if (result.toolName?.includes('create_skill')) {
              window.dispatchEvent(new CustomEvent('skills-updated'));
            }
            if (result.toolName?.includes('save_memory') || result.toolName?.includes('forget_memory')) {
              window.dispatchEvent(new CustomEvent('memories-updated'));
            }
          },
          onSubagentStart: (data) => {
            flushNow();
            if (state.currentText.trim()) {
              const segType = state.phase === 'answer' ? 'answer' : 'thinking';
              state.segments.push({ type: segType, text: state.currentText });
              state.currentText = '';
            }
            state.segments.push({
              type: 'subagent_start',
              subagentId: data.id,
              subagentName: data.name,
              text: data.prompt,
            });
            updateMessages(msgs =>
              msgs.map(m =>
                m.id === assistantId
                  ? { ...m, segments: [...state.segments] }
                  : m
              )
            );
          },
          onSubagentEnd: (data) => {
            state.segments.push({
              type: 'subagent_end',
              subagentId: data.id,
              subagentName: data.name,
              chart_spec: data.chart_spec,
              sqlResults: data.sql_results,
              text: data.result,
            });
            updateMessages(msgs =>
              msgs.map(m =>
                m.id === assistantId
                  ? { ...m, segments: [...state.segments] }
                  : m
              )
            );
          },
          onDone: (newSessionId) => {
            if (newSessionId) {
              state.sessionId = newSessionId;
              sessionIdRef.current = newSessionId;
            }
            flushNow();
            if (state.currentText.trim()) {
              state.segments.push({ type: 'answer', text: state.currentText });
              state.currentText = '';
            }
            updateMessages(msgs =>
              msgs.map(m =>
                m.id === assistantId
                  ? { ...m, isStreaming: false, currentPhase: undefined, segments: [...state.segments] }
                  : m
              )
            );
            if (convId && activeConversationIdRef.current !== convId) {
              messagesCacheRef.current.set(convId, state.messages);
            }
            cleanupStream();
            if (activeConversationIdRef.current === convId) {
              setIsStreaming(false);
            }
          },
          onError: (error) => {
            flushNow();
            if (state.currentText.trim()) {
              const segType = state.phase === 'answer' ? 'answer' : 'thinking';
              state.segments.push({ type: segType, text: state.currentText });
              state.currentText = '';
            }
            state.segments.push({ type: 'error', errorMessage: error });
            updateMessages(msgs =>
              msgs.map(m =>
                m.id === assistantId
                  ? { ...m, isStreaming: false, currentPhase: undefined, segments: [...state.segments] }
                  : m
              )
            );
            if (convId && activeConversationIdRef.current !== convId) {
              messagesCacheRef.current.set(convId, state.messages);
            }
            cleanupStream();
            if (activeConversationIdRef.current === convId) {
              setIsStreaming(false);
            }
          },
          onUserQuestion: (data) => {
            flushNow();
            if (state.currentText.trim()) {
              const segType = state.phase === 'answer' ? 'answer' : 'thinking';
              state.segments.push({ type: segType, text: state.currentText });
              state.currentText = '';
            }
            state.segments.push({ type: 'user_question', questionData: data });
            updateMessages(msgs =>
              msgs.map(m =>
                m.id === assistantId
                  ? { ...m, segments: [...state.segments] }
                  : m
              )
            );
          },
        },
        controller.signal,
        userSessionId,
        skills,
      );
    },
    [flushTextForStream, refreshTables, userSessionId]
  );

  const editMessage = useCallback(
    async (messageIndex: number, newContent: string) => {
      const convId = activeConversationIdRef.current;

      // If this conversation has an active stream, abort it first
      let existingMessages: ChatMessage[] | null = null;
      if (convId && streamStatesRef.current.has(convId)) {
        const existingState = streamStatesRef.current.get(convId)!;
        existingMessages = existingState.messages;
        existingState.abortController.abort();
        if (existingState.flushTimer) {
          clearTimeout(existingState.flushTimer);
        }
        streamStatesRef.current.delete(convId);
        setStreamingConversationIds(prev => {
          const next = new Set(prev);
          if (convId) next.delete(convId);
          return next;
        });
      }

      // Truncate messages at the edit point in the backend
      if (convId) {
        try {
          await fetch(`/api/conversations/${convId}/messages?from_sort_order=${messageIndex}`, {
            method: 'DELETE',
          });
        } catch {
          // Best-effort
        }
        messagesCacheRef.current.delete(convId);
      }

      // Build conversation history from messages before the edit point
      const currentMsgs = existingMessages || messagesRef.current;
      const conversationHistory: { role: string; content: string }[] = [];
      for (let i = 0; i < messageIndex; i++) {
        const msg = currentMsgs[i];
        if (msg.role === 'user' || msg.role === 'assistant') {
          conversationHistory.push({ role: msg.role, content: msg.content });
        }
      }

      const controller = new AbortController();
      const assistantId = generateId();

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

      const truncatedMessages = currentMsgs.slice(0, messageIndex);
      const streamMessages = [...truncatedMessages, userMsg, assistantMsg];

      // Create per-conversation stream state
      const state: StreamState = {
        assistantId,
        segments: [],
        currentText: '',
        textBuffer: '',
        phase: 'thinking',
        abortController: controller,
        sessionId: null, // Edit starts a fresh session
        messages: streamMessages,
        flushTimer: null,
      };

      if (convId) {
        streamStatesRef.current.set(convId, state);
        setStreamingConversationIds(prev => new Set(prev).add(convId));
      }

      setMessages(streamMessages);
      setIsStreaming(true);

      // Helper to update stream messages and optionally React state
      const updateMessages = (updater: (msgs: ChatMessage[]) => ChatMessage[]) => {
        state.messages = updater(state.messages);
        if (activeConversationIdRef.current === convId) {
          setMessages(state.messages);
        }
      };

      // Helper to schedule text flush
      const scheduleFlush = () => {
        if (!state.flushTimer) {
          state.flushTimer = setTimeout(() => {
            flushTextForStream(state, convId);
            state.flushTimer = null;
          }, 50);
        }
      };

      // Helper to flush pending text immediately
      const flushNow = () => {
        if (state.flushTimer) {
          clearTimeout(state.flushTimer);
          state.flushTimer = null;
        }
        flushTextForStream(state, convId);
      };

      // Helper to finalize stream
      const cleanupStream = () => {
        if (state.flushTimer) {
          clearTimeout(state.flushTimer);
          state.flushTimer = null;
        }
        if (convId) {
          streamStatesRef.current.delete(convId);
          setStreamingConversationIds(prev => {
            const next = new Set(prev);
            if (convId) next.delete(convId);
            return next;
          });
        }
      };

      await runAgentEditLoop(
        newContent,
        conversationHistory,
        generateUUID(),
        {
          onTextChunk: (chunk) => {
            state.textBuffer += chunk;
            scheduleFlush();
          },
          onThinkingDone: () => {
            flushNow();
            if (state.currentText.trim()) {
              state.segments.push({ type: 'thinking', text: state.currentText });
              state.currentText = '';
            }
            state.phase = 'answer';
            updateMessages(msgs =>
              msgs.map(m =>
                m.id === assistantId
                  ? { ...m, currentPhase: 'answer', segments: [...state.segments] }
                  : m
              )
            );
          },
          onToolCall: (pending: ToolCallResult) => {
            flushNow();
            if (state.currentText.trim()) {
              const segType = state.phase === 'answer' ? 'answer' : 'thinking';
              state.segments.push({ type: segType, text: state.currentText });
              state.currentText = '';
            }
            state.segments.push({ type: 'tool', toolResult: pending });
            updateMessages(msgs =>
              msgs.map(m =>
                m.id === assistantId
                  ? { ...m, currentPhase: 'answer', segments: [...state.segments] }
                  : m
              )
            );
          },
          onToolResult: (result: ToolCallResult) => {
            const pendingIdx = state.segments.findIndex(
              s => s.type === 'tool' && s.toolResult?.toolCallId === result.toolCallId
            );
            if (pendingIdx !== -1) {
              const pending = state.segments[pendingIdx].toolResult!;
              state.segments[pendingIdx] = {
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
              state.segments.push({ type: 'tool', toolResult: result });
            }
            updateMessages(msgs =>
              msgs.map(m =>
                m.id === assistantId
                  ? { ...m, toolCalls: [...(m.toolCalls || []), result], segments: [...state.segments] }
                  : m
              )
            );
            refreshTables();
          },
          onSubagentStart: (data) => {
            flushNow();
            if (state.currentText.trim()) {
              const segType = state.phase === 'answer' ? 'answer' : 'thinking';
              state.segments.push({ type: segType, text: state.currentText });
              state.currentText = '';
            }
            state.segments.push({
              type: 'subagent_start',
              subagentId: data.id,
              subagentName: data.name,
              text: data.prompt,
            });
            updateMessages(msgs =>
              msgs.map(m =>
                m.id === assistantId
                  ? { ...m, segments: [...state.segments] }
                  : m
              )
            );
          },
          onSubagentEnd: (data) => {
            state.segments.push({
              type: 'subagent_end',
              subagentId: data.id,
              subagentName: data.name,
              chart_spec: data.chart_spec,
              sqlResults: data.sql_results,
              text: data.result,
            });
            updateMessages(msgs =>
              msgs.map(m =>
                m.id === assistantId
                  ? { ...m, segments: [...state.segments] }
                  : m
              )
            );
          },
          onDone: (newSessionId) => {
            if (newSessionId) {
              state.sessionId = newSessionId;
              sessionIdRef.current = newSessionId;
            }
            flushNow();
            if (state.currentText.trim()) {
              state.segments.push({ type: 'answer', text: state.currentText });
              state.currentText = '';
            }
            updateMessages(msgs =>
              msgs.map(m =>
                m.id === assistantId
                  ? { ...m, isStreaming: false, currentPhase: undefined, segments: [...state.segments] }
                  : m
              )
            );
            if (convId && activeConversationIdRef.current !== convId) {
              messagesCacheRef.current.set(convId, state.messages);
            }
            cleanupStream();
            if (activeConversationIdRef.current === convId) {
              setIsStreaming(false);
            }
          },
          onError: (error) => {
            flushNow();
            if (state.currentText.trim()) {
              const segType = state.phase === 'answer' ? 'answer' : 'thinking';
              state.segments.push({ type: segType, text: state.currentText });
              state.currentText = '';
            }
            state.segments.push({ type: 'error', errorMessage: error });
            updateMessages(msgs =>
              msgs.map(m =>
                m.id === assistantId
                  ? { ...m, isStreaming: false, currentPhase: undefined, segments: [...state.segments] }
                  : m
              )
            );
            if (convId && activeConversationIdRef.current !== convId) {
              messagesCacheRef.current.set(convId, state.messages);
            }
            cleanupStream();
            if (activeConversationIdRef.current === convId) {
              setIsStreaming(false);
            }
          },
          onUserQuestion: (data) => {
            flushNow();
            if (state.currentText.trim()) {
              const segType = state.phase === 'answer' ? 'answer' : 'thinking';
              state.segments.push({ type: segType, text: state.currentText });
              state.currentText = '';
            }
            state.segments.push({ type: 'user_question', questionData: data });
            updateMessages(msgs =>
              msgs.map(m =>
                m.id === assistantId
                  ? { ...m, segments: [...state.segments] }
                  : m
              )
            );
          },
        },
        controller.signal,
        userSessionId,
        convId,
      );
    },
    [flushTextForStream, refreshTables, userSessionId]
  );

  const deleteMessage = useCallback(
    (messageIndex: number) => {
      const convId = activeConversationIdRef.current;
      // Only block if this specific conversation is streaming
      if (convId && streamStatesRef.current.has(convId)) return;

      // Store remaining messages as history for Langfuse context on next send
      setMessages((prev) => {
        const remaining = prev.slice(0, messageIndex);
        pendingHistoryRef.current = remaining
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role, content: m.content }));
        return remaining;
      });

      // Persist the truncation to the backend
      if (convId) {
        fetch(`/api/conversations/${convId}/messages?from_sort_order=${messageIndex}`, {
          method: 'DELETE',
        }).catch(() => {
          // Best-effort: if this fails the UI is already updated
        });
        // Invalidate cache so switching back loads from backend
        messagesCacheRef.current.delete(convId);
      }

      // Clear session so next message starts fresh
      sessionIdRef.current = null;
    },
    []
  );

  const respondToQuestion = useCallback(
    async (questionId: string, answers: string[], freeText?: string) => {
      // Find the stream state that contains this question
      let targetState: StreamState | undefined;
      let targetConvId: string | null = null;

      // Search all active streams for the question
      for (const [cid, state] of streamStatesRef.current) {
        if (state.segments.some(s => s.type === 'user_question' && s.questionData?.questionId === questionId)) {
          targetState = state;
          targetConvId = cid;
          break;
        }
      }

      if (targetState) {
        const segIdx = targetState.segments.findIndex(
          s => s.type === 'user_question' && s.questionData?.questionId === questionId
        );
        if (segIdx !== -1) {
          targetState.segments[segIdx] = {
            ...targetState.segments[segIdx],
            userAnswer: answers,
            userFreeText: freeText,
          };
          targetState.messages = targetState.messages.map(m =>
            m.id === targetState!.assistantId
              ? { ...m, segments: [...targetState!.segments] }
              : m
          );
          if (activeConversationIdRef.current === targetConvId) {
            setMessages(targetState.messages);
          }
        }
      }

      // POST to backend
      try {
        await fetch('/api/chat/respond', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(userSessionId ? { 'X-Session-ID': userSessionId } : {}),
          },
          body: JSON.stringify({
            question_id: questionId,
            answers,
            free_text: freeText || null,
          }),
        });
      } catch (e) {
        console.error('Failed to respond to question:', e);
      }
    },
    [userSessionId]
  );

  const loadMessages = useCallback((msgs: ChatMessage[], outgoingConversationId?: string | null, incomingConversationId?: string | null) => {
    const outgoing = outgoingConversationId || null;
    const incoming = incomingConversationId || null;
    activeConversationIdRef.current = incoming;

    // Save outgoing conversation's messages to cache (only if not streaming --
    // streaming conversations keep their state in streamStatesRef)
    if (outgoing && !streamStatesRef.current.has(outgoing)) {
      const currentMsgs = messagesRef.current;
      if (currentMsgs.length > 0) {
        messagesCacheRef.current.set(outgoing, currentMsgs);
      }
    }

    // Check if incoming conversation has an active stream (re-attachment)
    if (incoming) {
      const streamState = streamStatesRef.current.get(incoming);
      if (streamState) {
        // Re-attach: use live stream messages
        setMessages(streamState.messages);
        setIsStreaming(true);
        return;
      }
    }

    // No active stream -- use backend data or cache
    let finalMsgs = msgs;
    if (incoming) {
      const cached = messagesCacheRef.current.get(incoming);
      if (cached && cached.length > 0 && cached.length > msgs.length) {
        finalMsgs = cached;
      }
      messagesCacheRef.current.delete(incoming);
    }

    setMessages(finalMsgs);
    const hasStreamingMsg = finalMsgs.some(m => m.isStreaming);
    setIsStreaming(hasStreamingMsg);
    sessionIdRef.current = null;
    pendingHistoryRef.current = null;
  }, []);

  const clearMessages = useCallback((outgoingConversationId?: string | null) => {
    const outgoing = outgoingConversationId || null;
    activeConversationIdRef.current = null;

    // Save outgoing messages to cache if not streaming
    if (outgoing && !streamStatesRef.current.has(outgoing)) {
      const currentMsgs = messagesRef.current;
      if (currentMsgs.length > 0) {
        messagesCacheRef.current.set(outgoing, currentMsgs);
      }
    }

    setMessages([]);
    setIsStreaming(false);
    sessionIdRef.current = null;
    pendingHistoryRef.current = null;
  }, []);

  return (
    <AgentContext.Provider
      value={{ messages, isStreaming, sendMessage, editMessage, deleteMessage, clearMessages, loadMessages, respondToQuestion, streamingConversationIds }}
    >
      {children}
    </AgentContext.Provider>
  );
}
