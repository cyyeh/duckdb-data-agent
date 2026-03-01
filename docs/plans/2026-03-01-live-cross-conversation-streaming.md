# Live Cross-Conversation Streaming Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable live re-attachment to background-streaming conversations, support multiple simultaneous streams, and show sidebar streaming indicators.

**Architecture:** Replace singleton streaming refs in AgentContext with a per-conversation `StreamState` map. SSE callbacks write to their own conversation's state. When the user switches conversations, the UI reads from the target conversation's StreamState (if streaming) for instant re-attachment. A React state `streamingConversationIds` tracks which conversations have active streams for sidebar indicators.

**Tech Stack:** React 18, TypeScript, Vite (frontend only — no backend changes)

---

### Task 1: Add StreamState type and streamStatesRef

**Files:**
- Modify: `frontend/src/contexts/AgentContext.tsx:1-51`

**Step 1: Add StreamState interface and replace singleton refs**

Add the `StreamState` interface after the existing imports. Replace the singleton refs (`assistantIdRef`, `segmentsRef`, `currentTextRef`, `textBufferRef`, `flushTimerRef`, `phaseRef`, `streamConversationIdRef`, `streamGenerationRef`) with a single `streamStatesRef` map and a `streamingConversationIds` state.

In `frontend/src/contexts/AgentContext.tsx`, after the imports add:

```typescript
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
```

Then inside `AgentProvider`, replace the singleton refs:

Remove these refs:
- `textBufferRef` (line 30)
- `flushTimerRef` (line 31)
- `assistantIdRef` (line 32)
- `segmentsRef` (line 33)
- `currentTextRef` (line 34)
- `phaseRef` (line 35)
- `streamConversationIdRef` (line 47)
- `streamGenerationRef` (line 51)

Add:
```typescript
const streamStatesRef = useRef<Map<string, StreamState>>(new Map());
const [streamingConversationIds, setStreamingConversationIds] = useState<Set<string>>(new Set());
```

Keep: `abortRef` (remove later in Task 2), `sessionIdRef`, `pendingHistoryRef`, `messagesRef`, `messagesCacheRef`, `activeConversationIdRef`.

**Step 2: Build the project to verify no runtime errors from type addition**

Run: `cd frontend && npx tsc --noEmit 2>&1 | head -30`
Expected: Type errors from references to removed refs (expected — we fix those in subsequent tasks)

**Step 3: Commit**

```bash
git add frontend/src/contexts/AgentContext.tsx
git commit -m "feat: add StreamState type and streamStatesRef map"
```

---

### Task 2: Refactor flushText to be per-stream

**Files:**
- Modify: `frontend/src/contexts/AgentContext.tsx:53-64`

**Step 1: Replace flushText with flushTextForStream**

Replace the existing `flushText` callback (lines 53-64) with a function that operates on a specific `StreamState`:

```typescript
const flushTextForStream = useCallback((state: StreamState, conversationId: string) => {
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
```

**Step 2: Commit**

```bash
git add frontend/src/contexts/AgentContext.tsx
git commit -m "refactor: make flushText per-stream with StreamState parameter"
```

---

### Task 3: Refactor sendMessage to use per-conversation StreamState

**Files:**
- Modify: `frontend/src/contexts/AgentContext.tsx:66-384`

This is the largest task. Replace all the singleton-ref-based callback logic in `sendMessage` with per-stream `StreamState` callbacks.

**Step 1: Rewrite sendMessage**

Key changes:
1. Remove global `if (isStreaming) return;` guard.
2. Add per-conversation guard: `if (conversationId && streamStatesRef.current.has(conversationId)) return;`
3. Create a `StreamState` object for this conversation and put it in `streamStatesRef`.
4. Add conversationId to `streamingConversationIds`.
5. All callbacks close over the `StreamState` object and `conversationId`, not singleton refs.
6. Each callback updates `state.messages` always, and `setMessages(state.messages)` only when `activeConversationIdRef.current === conversationId`.
7. `onDone` / `onError` remove the StreamState from the map and remove from `streamingConversationIds`.

The complete rewritten `sendMessage`:

```typescript
const sendMessage = useCallback(
  async (text: string, conversationId?: string | null) => {
    const convId = conversationId || null;
    // Per-conversation guard: don't double-send in same conversation
    if (convId && streamStatesRef.current.has(convId)) return;

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
          flushTextForStream(state, convId!);
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
      flushTextForStream(state, convId!);
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
          cleanupStream();
          if (activeConversationIdRef.current === convId) {
            setIsStreaming(false);
          } else if (convId) {
            // Cache final messages so switching back shows completed response
            messagesCacheRef.current.set(convId, state.messages);
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
          cleanupStream();
          if (activeConversationIdRef.current === convId) {
            setIsStreaming(false);
          } else if (convId) {
            messagesCacheRef.current.set(convId, state.messages);
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
```

**Step 2: Remove `abortRef` (no longer used by sendMessage)**

The `abortRef` is now stored per-stream in `StreamState.abortController`. Remove the `abortRef` declaration (line 29). If `editMessage` still uses it, keep it temporarily (handled in Task 5).

**Step 3: Verify compilation**

Run: `cd frontend && npx tsc --noEmit 2>&1 | head -30`
Expected: Errors from `editMessage`, `loadMessages`, `clearMessages` still referencing old refs (fixed in Tasks 4-5)

**Step 4: Commit**

```bash
git add frontend/src/contexts/AgentContext.tsx
git commit -m "feat: rewrite sendMessage with per-conversation StreamState"
```

---

### Task 4: Refactor loadMessages and clearMessages for re-attachment

**Files:**
- Modify: `frontend/src/contexts/AgentContext.tsx` (loadMessages ~720-811, clearMessages ~813-874)

**Step 1: Rewrite loadMessages**

The key change: when switching to a conversation that has an active stream in `streamStatesRef`, read its `state.messages` directly (re-attachment). No need to increment a generation counter.

```typescript
const loadMessages = useCallback((msgs: ChatMessage[], outgoingConversationId?: string | null, incomingConversationId?: string | null) => {
  const outgoing = outgoingConversationId || null;
  const incoming = incomingConversationId || null;
  activeConversationIdRef.current = incoming;

  // Save outgoing conversation's messages to cache (only if not streaming —
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

  // No active stream — use backend data or cache
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
```

**Step 2: Rewrite clearMessages**

```typescript
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
```

**Step 3: Verify compilation**

Run: `cd frontend && npx tsc --noEmit 2>&1 | head -30`
Expected: Errors only from `editMessage` and `respondToQuestion` (fixed in Task 5)

**Step 4: Commit**

```bash
git add frontend/src/contexts/AgentContext.tsx
git commit -m "feat: rewrite loadMessages/clearMessages with stream re-attachment"
```

---

### Task 5: Refactor editMessage, deleteMessage, respondToQuestion

**Files:**
- Modify: `frontend/src/contexts/AgentContext.tsx` (editMessage ~386-645, deleteMessage ~647-676, respondToQuestion ~678-718)

**Step 1: Refactor editMessage**

`editMessage` needs to:
1. Abort any existing stream for the active conversation.
2. Create a new `StreamState` for the edit.
3. Use the same per-stream callback pattern as `sendMessage`.

The structure mirrors `sendMessage` but uses `runAgentEditLoop` and truncates messages first. Apply the same pattern: create `StreamState`, close callbacks over it, use `updateMessages` helper.

Key changes vs current code:
- Get `convId` from `activeConversationIdRef.current`
- If `convId` has an active stream, abort it first: `streamStatesRef.current.get(convId)?.abortController.abort()`; then delete from map
- Create new `StreamState` with truncated messages
- Use same callback pattern as sendMessage (close over `state` and `convId`)

**Step 2: Refactor respondToQuestion**

Add `conversationId` parameter. Look up the stream state from `streamStatesRef.current.get(conversationId)` to find the correct `segments` and `assistantId`:

```typescript
const respondToQuestion = useCallback(
  async (questionId: string, answers: string[], freeText?: string, conversationId?: string | null) => {
    // Find the stream state that contains this question
    let targetState: StreamState | undefined;
    let targetConvId: string | null = null;
    if (conversationId) {
      targetState = streamStatesRef.current.get(conversationId);
      targetConvId = conversationId;
    }
    if (!targetState) {
      // Search all active streams
      for (const [cid, state] of streamStatesRef.current) {
        if (state.segments.some(s => s.type === 'user_question' && s.questionData?.questionId === questionId)) {
          targetState = state;
          targetConvId = cid;
          break;
        }
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

    // POST to backend (unchanged)
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
```

**Step 3: Refactor deleteMessage**

Change guard from `if (isStreaming) return;` to check per-conversation:

```typescript
const deleteMessage = useCallback(
  (messageIndex: number) => {
    const convId = activeConversationIdRef.current;
    // Only block if this specific conversation is streaming
    if (convId && streamStatesRef.current.has(convId)) return;
    // ... rest unchanged
  },
  []
);
```

**Step 4: Remove old singleton refs that are no longer referenced**

Remove `abortRef` if not used anywhere else. Verify no references to `streamGenerationRef`, `streamConversationIdRef`, `assistantIdRef`, `segmentsRef`, `currentTextRef`, `textBufferRef`, `flushTimerRef`, `phaseRef` remain.

**Step 5: Verify compilation**

Run: `cd frontend && npx tsc --noEmit 2>&1 | head -30`
Expected: PASS (or only warnings)

**Step 6: Commit**

```bash
git add frontend/src/contexts/AgentContext.tsx
git commit -m "feat: refactor editMessage/deleteMessage/respondToQuestion for per-stream state"
```

---

### Task 6: Expose streamingConversationIds in context and update ChatInput

**Files:**
- Modify: `frontend/src/hooks/useAgent.ts:4-13` — add `streamingConversationIds` to interface
- Modify: `frontend/src/contexts/AgentContext.tsx:876-883` — pass in provider value
- Modify: `frontend/src/components/ChatInput.tsx:17,49,140-145,151` — per-conversation isStreaming

**Step 1: Update AgentContextValue interface**

In `frontend/src/hooks/useAgent.ts`, add to the interface:

```typescript
streamingConversationIds: Set<string>;
```

And update the default context value:

```typescript
streamingConversationIds: new Set(),
```

**Step 2: Pass streamingConversationIds in AgentContext.Provider**

In `frontend/src/contexts/AgentContext.tsx`, add `streamingConversationIds` to the provider value object.

**Step 3: Update ChatInput to use per-conversation streaming**

In `frontend/src/components/ChatInput.tsx`:

Replace:
```typescript
const { sendMessage, isStreaming } = useAgent();
```

With:
```typescript
const { sendMessage, isStreaming, streamingConversationIds } = useAgent();
```

The existing `isStreaming` still works for the active conversation (set by `sendMessage` and `loadMessages`). But the send guard should also check:

```typescript
const handleSend = async () => {
  const trimmed = text.trim();
  if (!trimmed || isStreaming) return;
  // ... rest unchanged
};
```

This already works because `isStreaming` is set to true when the active conversation is streaming, and re-attachment sets it too.

**Step 4: Verify compilation**

Run: `cd frontend && npx tsc --noEmit 2>&1 | head -30`
Expected: PASS

**Step 5: Commit**

```bash
git add frontend/src/hooks/useAgent.ts frontend/src/contexts/AgentContext.tsx frontend/src/components/ChatInput.tsx
git commit -m "feat: expose streamingConversationIds in AgentContext"
```

---

### Task 7: Add sidebar streaming indicator

**Files:**
- Modify: `frontend/src/components/Sidebar.tsx:10-26,28,181-189` — add and thread prop
- Modify: `frontend/src/components/ConversationHistory.tsx:12-19,115-165` — render indicator
- Modify: `frontend/src/components/ConversationHistory.css` — pulse animation
- Modify: `frontend/src/App.tsx:54,258-274` — pass prop from context

**Step 1: Thread streamingConversationIds through App -> Sidebar -> ConversationHistory**

In `frontend/src/App.tsx`, get from agent context:

```typescript
const { clearMessages, loadMessages, streamingConversationIds } = useAgent();
```

Pass to Sidebar:

```typescript
<Sidebar
  // ... existing props
  streamingConversationIds={streamingConversationIds}
/>
```

In `frontend/src/components/Sidebar.tsx`, add to `SidebarProps`:

```typescript
streamingConversationIds: Set<string>;
```

Thread to ConversationHistory:

```typescript
<ConversationHistory
  // ... existing props
  streamingConversationIds={streamingConversationIds}
/>
```

**Step 2: Add streaming dot to ConversationHistory**

In `frontend/src/components/ConversationHistory.tsx`, add to `ConversationHistoryProps`:

```typescript
streamingConversationIds: Set<string>;
```

In the conversation item render, add a streaming dot next to the title:

```tsx
<div className="conv-history__item-title">
  {streamingConversationIds.has(conv.id) && (
    <span className="conv-history__streaming-dot" />
  )}
  {conv.title || t('untitled')}
</div>
```

**Step 3: Add CSS animation**

In `frontend/src/components/ConversationHistory.css`, add:

```css
.conv-history__streaming-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-color, #3b82f6);
  margin-right: 6px;
  vertical-align: middle;
  flex-shrink: 0;
  animation: conv-streaming-pulse 1.5s ease-in-out infinite;
}

@keyframes conv-streaming-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
```

**Step 4: Verify compilation**

Run: `cd frontend && npx tsc --noEmit 2>&1 | head -30`
Expected: PASS

**Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/src/components/Sidebar.tsx frontend/src/components/ConversationHistory.tsx frontend/src/components/ConversationHistory.css
git commit -m "feat: add pulsing dot indicator for streaming conversations in sidebar"
```

---

### Task 8: Verify build and manual smoke test

**Files:** None (verification only)

**Step 1: Full TypeScript check**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS with zero errors

**Step 2: Production build**

Run: `cd frontend && npm run build`
Expected: Build succeeds

**Step 3: Manual smoke test checklist**

Start the app and verify:
1. Send a message in a new conversation — text streams live as before
2. While streaming, click "New Chat" — old conversation gets pulsing dot in sidebar
3. Switch back to streaming conversation — text resumes live (re-attachment works)
4. Send a message in the new conversation while old one still streams — both stream concurrently
5. When a background stream completes, pulsing dot disappears
6. Switch to the completed background conversation — full response is visible
7. Edit a message — works as before
8. Delete a message — works as before

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: address issues found during smoke testing"
```
