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
            // If the user switched conversations, this stream is now
            // backgrounded.  Don't touch shared state — just clear the
            // stale cache so the next switch loads the full backend response.
            if (activeConversationIdRef.current !== conversationId) {
              if (conversationId) messagesCacheRef.current.delete(conversationId);
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
            if (activeConversationIdRef.current !== conversationId) {
              if (conversationId) messagesCacheRef.current.delete(conversationId);
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
            // Guard: if refs were taken over by another stream, bail out
            if (assistantIdRef.current !== assistantId) return;
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
            if (assistantIdRef.current !== assistantId) return;
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
    activeConversationIdRef.current = incomingConversationId || null;

    // Don't abort the SSE stream — let the backend agent continue running
    // in the background.  The onDone/onError callbacks detect that the
    // conversation has changed and handle cleanup (cache invalidation).
    // Only clear the flush timer so it doesn't interfere with the new
    // conversation's state.
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }

    // Prefer cached messages when the cache is at least as complete as
    // the backend response (cache keeps rich segments / streaming data).
    let finalMsgs = msgs;
    if (incomingConversationId) {
      const cached = messagesCacheRef.current.get(incomingConversationId);
      if (cached && cached.length > 0 && cached.length >= msgs.length) {
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
      if (outgoingConversationId && prev.length > 0) {
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
              // Keep isStreaming: true — the SSE stream continues in
              // the background so the UI should show a thinking indicator.
              segments: finalSegments.length > 0 ? finalSegments : m.segments,
            };
          }
          return m;
        });
        // Filter out completed-but-empty assistant messages. Streaming
        // messages are always kept so the thinking indicator stays visible.
        const toCache = cleaned.filter(m => {
          if (m.role === 'assistant' && !m.isStreaming && !m.content?.trim() && (!m.segments || m.segments.length === 0)) {
            return false;
          }
          return true;
        });
        messagesCacheRef.current.set(outgoingConversationId, toCache);
      }
      return finalMsgs;
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

  const clearMessages = useCallback((outgoingConversationId?: string | null) => {
    activeConversationIdRef.current = null;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
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
      if (outgoingConversationId && prev.length > 0) {
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
              isStreaming: false,
              currentPhase: undefined,
              segments: finalSegments.length > 0 ? finalSegments : m.segments,
            };
          }
          return m.isStreaming ? { ...m, isStreaming: false, currentPhase: undefined } : m;
        });
        const toCache = cleaned.filter(m => {
          if (m.role === 'assistant' && !m.content?.trim() && (!m.segments || m.segments.length === 0)) {
            return false;
          }
          return true;
        });
        messagesCacheRef.current.set(outgoingConversationId, toCache);
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
