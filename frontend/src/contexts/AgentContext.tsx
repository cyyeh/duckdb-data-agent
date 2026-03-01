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
import { buildChatMessages } from '../utils/buildChatMessages';

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
  const abortRef = useRef<AbortController | null>(null);
  const textBufferRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const assistantIdRef = useRef('');
  const segmentsRef = useRef<ContentSegment[]>([]);
  const currentTextRef = useRef('');
  const phaseRef = useRef<'thinking' | 'answer'>('thinking');
  const sessionIdRef = useRef<string | null>(null);
  const pendingHistoryRef = useRef<{ role: string; content: string }[] | null>(null);
  // Keep a ref in sync with messages so sendMessage always reads the latest
  const messagesRef = useRef<ChatMessage[]>(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  // Cache messages per conversation so switching away doesn't lose in-progress data
  const messagesCacheRef = useRef<Map<string, ChatMessage[]>>(new Map());
  // Track which conversation is currently displayed so background streams can detect they're stale
  const activeConversationIdRef = useRef<string | null>(null);
  // Track which conversation owns the current SSE stream (set in sendMessage).
  // Used as a fallback when React state is stale (e.g. user switches before re-render).
  const streamConversationIdRef = useRef<string | null>(null);
  // Generation counter: incremented on every stream-disrupting event (sendMessage,
  // loadMessages, clearMessages).  Callbacks capture the generation at creation time
  // and bail out if the ref has since advanced, preventing cross-conversation leaks.
  const streamGenerationRef = useRef(0);

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
    async (text: string, conversationId?: string | null) => {
      if (isStreaming) return;
      streamConversationIdRef.current = conversationId || null;
      const generation = ++streamGenerationRef.current;

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
      phaseRef.current = 'thinking';

      // Build conversation history from current messages for resume fallback.
      // Read from messagesRef (not the stale closure `messages`) so that
      // switching conversations is reflected immediately.
      const history = messagesRef.current
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content }));

      // If there's pending history from a delete, start a new Langfuse session with that context
      const pendingHistory = pendingHistoryRef.current;
      pendingHistoryRef.current = null;
      const langfuseSessionId = pendingHistory ? generateUUID() : null;

      const controller = new AbortController();
      abortRef.current = controller;

      // Extract all /skill-name references from message
      let actualMessage = text;
      let skills: string[] | undefined;
      const slashMatches = [...text.matchAll(/\/([a-z0-9-]+)/g)];
      if (slashMatches.length > 0) {
        skills = slashMatches.map((m) => m[1]);
        actualMessage = slashMatches.reduce((msg, m) => msg.replace(m[0], ''), text).trim() || text;
      }

      await runAgentLoop(
        actualMessage,
        sessionIdRef.current,
        langfuseSessionId,
        pendingHistory ?? (history.length > 0 ? history : null),
        conversationId,
        {
          onTextChunk: (chunk) => {
            if (streamGenerationRef.current !== generation) return;
            textBufferRef.current += chunk;
            if (!flushTimerRef.current) {
              flushTimerRef.current = setTimeout(() => {
                flushText();
                flushTimerRef.current = null;
              }, 50);
            }
          },
          onThinkingDone: () => {
            if (streamGenerationRef.current !== generation) return;
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
            phaseRef.current = 'answer';
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, currentPhase: 'answer', segments: [...segmentsRef.current] }
                  : m
              )
            );
          },
          onToolCall: (pending: ToolCallResult) => {
            if (streamGenerationRef.current !== generation) return;
            if (flushTimerRef.current) {
              clearTimeout(flushTimerRef.current);
              flushTimerRef.current = null;
            }
            flushText();
            if (currentTextRef.current.trim()) {
              const segType = phaseRef.current === 'answer' ? 'answer' : 'thinking';
              segmentsRef.current.push({ type: segType, text: currentTextRef.current });
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
                  ? { ...m, currentPhase: 'answer', segments: [...segmentsRef.current] }
                  : m
              )
            );
          },
          onToolResult: (result: ToolCallResult) => {
            if (streamGenerationRef.current !== generation) return;
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
            // When a skill is created, notify SkillsPanel to refresh
            if (result.toolName?.includes('create_skill')) {
              window.dispatchEvent(new CustomEvent('skills-updated'));
            }
            // When a memory is saved or forgotten, notify MemoriesPanel to refresh
            if (result.toolName?.includes('save_memory') || result.toolName?.includes('forget_memory')) {
              window.dispatchEvent(new CustomEvent('memories-updated'));
            }
          },
          onSubagentStart: (data) => {
            if (streamGenerationRef.current !== generation) return;
            if (flushTimerRef.current) {
              clearTimeout(flushTimerRef.current);
              flushTimerRef.current = null;
            }
            flushText();
            if (currentTextRef.current.trim()) {
              const segType = phaseRef.current === 'answer' ? 'answer' : 'thinking';
              segmentsRef.current.push({ type: segType, text: currentTextRef.current });
              currentTextRef.current = '';
            }
            segmentsRef.current.push({
              type: 'subagent_start',
              subagentId: data.id,
              subagentName: data.name,
              text: data.prompt,
            });
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, segments: [...segmentsRef.current] }
                  : m
              )
            );
          },
          onSubagentEnd: (data) => {
            if (streamGenerationRef.current !== generation) return;
            segmentsRef.current.push({
              type: 'subagent_end',
              subagentId: data.id,
              subagentName: data.name,
              chart_spec: data.chart_spec,
              sqlResults: data.sql_results,
              text: data.result,
            });
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, segments: [...segmentsRef.current] }
                  : m
              )
            );
          },
          onDone: (newSessionId) => {
            // If this stream's generation is stale (user switched conversations
            // or started a new stream), don't touch shared state — just clear
            // the stale cache so the next switch loads the full backend response.
            if (streamGenerationRef.current !== generation) {
              if (conversationId) messagesCacheRef.current.delete(conversationId);
              // If user is currently viewing this conversation, re-fetch from
              // backend so the completed response appears automatically.
              if (conversationId && activeConversationIdRef.current === conversationId) {
                // Small delay to let the backend's finally block persist the response.
                setTimeout(() => {
                  if (activeConversationIdRef.current !== conversationId) return;
                  fetch(`/api/conversations/${conversationId}`)
                    .then(res => res.ok ? res.json() : null)
                    .then(conv => {
                      if (!conv?.messages || activeConversationIdRef.current !== conversationId) return;
                      setMessages(buildChatMessages(conv.messages));
                      setIsStreaming(false);
                    })
                    .catch(() => {});
                }, 300);
              }
              return;
            }
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
            if (streamGenerationRef.current !== generation) {
              if (conversationId) messagesCacheRef.current.delete(conversationId);
              // Re-fetch if user is viewing this conversation
              if (conversationId && activeConversationIdRef.current === conversationId) {
                setTimeout(() => {
                  if (activeConversationIdRef.current !== conversationId) return;
                  fetch(`/api/conversations/${conversationId}`)
                    .then(res => res.ok ? res.json() : null)
                    .then(conv => {
                      if (!conv?.messages || activeConversationIdRef.current !== conversationId) return;
                      setMessages(buildChatMessages(conv.messages));
                      setIsStreaming(false);
                    })
                    .catch(() => {});
                }, 300);
              }
              return;
            }
            if (flushTimerRef.current) {
              clearTimeout(flushTimerRef.current);
              flushTimerRef.current = null;
            }
            flushText();
            if (currentTextRef.current.trim()) {
              const segType = phaseRef.current === 'answer' ? 'answer' : 'thinking';
              segmentsRef.current.push({ type: segType, text: currentTextRef.current });
              currentTextRef.current = '';
            }
            segmentsRef.current.push({ type: 'error', errorMessage: error });
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
          onUserQuestion: (data) => {
            if (streamGenerationRef.current !== generation) return;
            if (flushTimerRef.current) {
              clearTimeout(flushTimerRef.current);
              flushTimerRef.current = null;
            }
            flushText();
            if (currentTextRef.current.trim()) {
              const segType = phaseRef.current === 'answer' ? 'answer' : 'thinking';
              segmentsRef.current.push({ type: segType, text: currentTextRef.current });
              currentTextRef.current = '';
            }
            segmentsRef.current.push({
              type: 'user_question',
              questionData: data,
            });
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, segments: [...segmentsRef.current] }
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
    [isStreaming, flushText, refreshTables, userSessionId]
  );

  const editMessage = useCallback(
    async (messageIndex: number, newContent: string) => {
      if (isStreaming) return;
      const generation = ++streamGenerationRef.current;
      const convId = activeConversationIdRef.current;

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
      phaseRef.current = 'thinking';

      const controller = new AbortController();
      abortRef.current = controller;

      await runAgentEditLoop(
        newContent,
        conversationHistory,
        generateUUID(),
        {
          onTextChunk: (chunk) => {
            if (streamGenerationRef.current !== generation) return;
            textBufferRef.current += chunk;
            if (!flushTimerRef.current) {
              flushTimerRef.current = setTimeout(() => {
                flushText();
                flushTimerRef.current = null;
              }, 50);
            }
          },
          onThinkingDone: () => {
            if (streamGenerationRef.current !== generation) return;
            if (flushTimerRef.current) {
              clearTimeout(flushTimerRef.current);
              flushTimerRef.current = null;
            }
            flushText();
            if (currentTextRef.current.trim()) {
              segmentsRef.current.push({ type: 'thinking', text: currentTextRef.current });
              currentTextRef.current = '';
            }
            phaseRef.current = 'answer';
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, currentPhase: 'answer', segments: [...segmentsRef.current] }
                  : m
              )
            );
          },
          onToolCall: (pending: ToolCallResult) => {
            if (streamGenerationRef.current !== generation) return;
            if (flushTimerRef.current) {
              clearTimeout(flushTimerRef.current);
              flushTimerRef.current = null;
            }
            flushText();
            if (currentTextRef.current.trim()) {
              const segType = phaseRef.current === 'answer' ? 'answer' : 'thinking';
              segmentsRef.current.push({ type: segType, text: currentTextRef.current });
              currentTextRef.current = '';
            }
            segmentsRef.current.push({ type: 'tool', toolResult: pending });
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, currentPhase: 'answer', segments: [...segmentsRef.current] }
                  : m
              )
            );
          },
          onToolResult: (result: ToolCallResult) => {
            if (streamGenerationRef.current !== generation) return;
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
          onSubagentStart: (data) => {
            if (streamGenerationRef.current !== generation) return;
            if (flushTimerRef.current) {
              clearTimeout(flushTimerRef.current);
              flushTimerRef.current = null;
            }
            flushText();
            if (currentTextRef.current.trim()) {
              const segType = phaseRef.current === 'answer' ? 'answer' : 'thinking';
              segmentsRef.current.push({ type: segType, text: currentTextRef.current });
              currentTextRef.current = '';
            }
            segmentsRef.current.push({
              type: 'subagent_start',
              subagentId: data.id,
              subagentName: data.name,
              text: data.prompt,
            });
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, segments: [...segmentsRef.current] }
                  : m
              )
            );
          },
          onSubagentEnd: (data) => {
            if (streamGenerationRef.current !== generation) return;
            segmentsRef.current.push({
              type: 'subagent_end',
              subagentId: data.id,
              subagentName: data.name,
              chart_spec: data.chart_spec,
              sqlResults: data.sql_results,
              text: data.result,
            });
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, segments: [...segmentsRef.current] }
                  : m
              )
            );
          },
          onDone: (newSessionId) => {
            if (streamGenerationRef.current !== generation) return;
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
            if (streamGenerationRef.current !== generation) return;
            if (flushTimerRef.current) {
              clearTimeout(flushTimerRef.current);
              flushTimerRef.current = null;
            }
            flushText();
            if (currentTextRef.current.trim()) {
              const segType = phaseRef.current === 'answer' ? 'answer' : 'thinking';
              segmentsRef.current.push({ type: segType, text: currentTextRef.current });
              currentTextRef.current = '';
            }
            segmentsRef.current.push({ type: 'error', errorMessage: error });
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
          onUserQuestion: (data) => {
            if (streamGenerationRef.current !== generation) return;
            if (flushTimerRef.current) {
              clearTimeout(flushTimerRef.current);
              flushTimerRef.current = null;
            }
            flushText();
            if (currentTextRef.current.trim()) {
              const segType = phaseRef.current === 'answer' ? 'answer' : 'thinking';
              segmentsRef.current.push({ type: segType, text: currentTextRef.current });
              currentTextRef.current = '';
            }
            segmentsRef.current.push({
              type: 'user_question',
              questionData: data,
            });
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, segments: [...segmentsRef.current] }
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

      // Persist the truncation to the backend
      const convId = activeConversationIdRef.current;
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
    [isStreaming]
  );

  const respondToQuestion = useCallback(
    async (questionId: string, answers: string[], freeText?: string) => {
      // Update the segment to show the user's answer
      const segIdx = segmentsRef.current.findIndex(
        (s) => s.type === 'user_question' && s.questionData?.questionId === questionId
      );
      if (segIdx !== -1) {
        segmentsRef.current[segIdx] = {
          ...segmentsRef.current[segIdx],
          userAnswer: answers,
          userFreeText: freeText,
        };
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantIdRef.current
              ? { ...m, segments: [...segmentsRef.current] }
              : m
          )
        );
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
    // Invalidate any in-flight stream so its callbacks become no-ops.
    ++streamGenerationRef.current;

    // Fall back to the stream's conversation ID when React state is stale
    // (e.g. user switches before re-render after createConversation).
    const outgoing = outgoingConversationId || streamConversationIdRef.current;
    activeConversationIdRef.current = incomingConversationId || null;

    // Do NOT abort the SSE stream — let the agent finish in the background.
    // The generation counter ensures stale callbacks are no-ops.
    // The backend's finally block will persist the full response.
    // When the user switches back, the backend has the complete data.
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }

    // Use cache only when it has MORE messages than backend (meaning the
    // backend hasn't persisted the assistant response yet).  When counts
    // are equal, prefer backend — it has the final persisted data which
    // may be more complete than the frozen cache snapshot.
    let finalMsgs = msgs;
    if (incomingConversationId) {
      const cached = messagesCacheRef.current.get(incomingConversationId);
      if (cached && cached.length > 0 && cached.length > msgs.length) {
        finalMsgs = cached;
      }
      // Clear used cache entry so stale data doesn't persist forever
      messagesCacheRef.current.delete(incomingConversationId);
    }

    // Capture ref values NOW — React 18 batching may defer the updater
    // function below until after the ref resets at the bottom of this
    // function, so reading refs inside the updater would see empty values.
    const capturedTextBuffer = textBufferRef.current;
    const capturedAssistantId = assistantIdRef.current;
    const capturedSegments = [...segmentsRef.current];
    const capturedCurrentText = currentTextRef.current;
    const capturedPhase = phaseRef.current;

    // Save current messages to cache before replacing them.
    setMessages(prev => {
      if (outgoing && prev.length > 0) {
        const pendingText = capturedTextBuffer;
        const aId = capturedAssistantId;

        // Build finalized segments including any unflushed text
        let finalSegments = [...capturedSegments];
        const pendingSegmentText = capturedCurrentText + pendingText;
        if (pendingSegmentText.trim()) {
          const segType = capturedPhase === 'answer' ? 'answer' : 'thinking';
          finalSegments.push({ type: segType as ContentSegment['type'], text: pendingSegmentText });
        }

        const cleaned = prev.map(m => {
          if (m.id === aId && m.isStreaming) {
            return {
              ...m,
              content: m.content + pendingText,
              // Keep isStreaming flag — the background stream continues.
              segments: finalSegments.length > 0 ? finalSegments : m.segments,
            };
          }
          return m;
        });
        // Filter out empty NON-streaming assistant messages.
        // Keep streaming ones even if empty — they show a "thinking" indicator.
        const toCache = cleaned.filter(m => {
          if (m.role === 'assistant' && !m.isStreaming && !m.content?.trim() && (!m.segments || m.segments.length === 0)) {
            return false;
          }
          return true;
        });
        messagesCacheRef.current.set(outgoing, toCache);
      }
      return finalMsgs;
    });

    // If the loaded messages include a streaming assistant (background stream
    // still running), keep isStreaming = true so the ChatInput shows "waiting".
    // The stale onDone will set isStreaming = false when the stream completes.
    const hasStreamingMsg = finalMsgs.some(m => m.isStreaming);
    setIsStreaming(hasStreamingMsg);
    textBufferRef.current = '';
    currentTextRef.current = '';
    segmentsRef.current = [];
    assistantIdRef.current = '';
    phaseRef.current = 'thinking';
    sessionIdRef.current = null;
    pendingHistoryRef.current = null;
  }, []);

  const clearMessages = useCallback((outgoingConversationId?: string | null) => {
    ++streamGenerationRef.current;
    const outgoing = outgoingConversationId || streamConversationIdRef.current;
    activeConversationIdRef.current = null;
    // Do NOT abort the SSE stream — let the agent finish in the background.
    // The generation counter ensures stale callbacks are no-ops.
    // The backend's finally block will persist the full response.
    // When the user switches back, the backend has the complete data.
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }

    // Capture refs before setMessages (React 18 batching may defer the updater)
    const capturedTextBuffer = textBufferRef.current;
    const capturedAssistantId = assistantIdRef.current;
    const capturedSegments = [...segmentsRef.current];
    const capturedCurrentText = currentTextRef.current;
    const capturedPhase = phaseRef.current;

    setMessages(prev => {
      if (outgoing && prev.length > 0) {
        const pendingText = capturedTextBuffer;
        const aId = capturedAssistantId;
        let finalSegments = [...capturedSegments];
        const pendingSegmentText = capturedCurrentText + pendingText;
        if (pendingSegmentText.trim()) {
          const segType = capturedPhase === 'answer' ? 'answer' : 'thinking';
          finalSegments.push({ type: segType as ContentSegment['type'], text: pendingSegmentText });
        }
        const cleaned = prev.map(m => {
          if (m.id === aId && m.isStreaming) {
            return {
              ...m,
              content: m.content + pendingText,
              // Keep isStreaming flag — the background stream continues.
              segments: finalSegments.length > 0 ? finalSegments : m.segments,
            };
          }
          return m;
        });
        // Filter out empty NON-streaming assistant messages.
        // Keep streaming ones even if empty — they show a "thinking" indicator.
        const toCache = cleaned.filter(m => {
          if (m.role === 'assistant' && !m.isStreaming && !m.content?.trim() && (!m.segments || m.segments.length === 0)) {
            return false;
          }
          return true;
        });
        messagesCacheRef.current.set(outgoing, toCache);
      }
      return [];
    });
    setIsStreaming(false);
    textBufferRef.current = '';
    currentTextRef.current = '';
    segmentsRef.current = [];
    assistantIdRef.current = '';
    phaseRef.current = 'thinking';
    sessionIdRef.current = null;
    pendingHistoryRef.current = null;
  }, []);

  return (
    <AgentContext.Provider
      value={{ messages, isStreaming, sendMessage, editMessage, deleteMessage, clearMessages, loadMessages, respondToQuestion }}
    >
      {children}
    </AgentContext.Provider>
  );
}
