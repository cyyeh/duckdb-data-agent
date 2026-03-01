# Live Cross-Conversation Streaming

## Problem

When viewing a background-streaming conversation, users see a frozen "thinking" state rather than live text appearing character-by-character. The final result only appears once the stream completes and the user switches away and back. This is because the SSE callbacks are tied to one active stream via a generation counter, and switching conversations silences them.

## Requirements

- When switching back to a conversation that's still streaming, live text resumes immediately (re-attachment)
- Multiple simultaneous streams supported (send in Conv A, then send in Conv B while A streams)
- Sidebar shows a pulsing dot next to conversations with active background streams
- No backend changes required

## Approach: Per-Conversation Stream Manager

Replace the singleton refs (`assistantIdRef`, `segmentsRef`, `textBufferRef`, etc.) with a `Map<conversationId, StreamState>`. Each active stream gets its own isolated state. When the user switches conversations, the UI subscribes to whichever conversation's stream state is active.

## Design

### 1. StreamState Type

```typescript
interface StreamState {
  assistantId: string;
  segments: ContentSegment[];
  currentText: string;
  textBuffer: string;
  phase: 'thinking' | 'answer';
  abortController: AbortController;
  sessionId: string | null;
  messages: ChatMessage[];       // live-updated by callbacks
  flushTimer: ReturnType<typeof setTimeout> | null;
}
```

### 2. Key Data Structures in AgentContext

- `streamStatesRef = useRef<Map<string, StreamState>>(new Map())` — active streams
- `activeConversationIdRef` — which conversation is being viewed (unchanged)
- `messagesCacheRef` — cache for non-streaming conversations (unchanged)
- `streamingConversationIds: Set<string>` — React state for sidebar indicator
- Remove: `streamGenerationRef`, `assistantIdRef`, `segmentsRef`, `currentTextRef`, `phaseRef`, `textBufferRef`, `flushTimerRef`, `streamConversationIdRef` (all absorbed into StreamState)

### 3. Callback Isolation

Each `sendMessage` creates a `StreamState` and passes callbacks that close over it:

```
callback(data) {
  // Always update the stream's own state
  streamState.messages = updatedMessages;
  streamState.segments = updatedSegments;
  // Only push to React state if this conversation is being viewed
  if (activeConversationIdRef.current === conversationId) {
    setMessages(streamState.messages);
  }
}
```

No generation counter needed — callbacks write to their own StreamState, never to shared refs.

### 4. Conversation Switching (Re-attachment)

When user switches FROM A TO B:

1. Snapshot A's `messages` state into `streamStatesRef.get(A).messages` (if streaming) or `messagesCacheRef` (if not)
2. Check if B has an active stream in `streamStatesRef`:
   - **Yes (re-attach):** Read `streamStatesRef.get(B).messages`, set as React `messages` state. Future callbacks for B also call `setMessages` since B is now active. Live text resumes immediately.
   - **No:** Fetch from `/api/conversations/B` or use `messagesCacheRef`.
3. Update `activeConversationIdRef` to B.

### 5. Multiple Simultaneous Streams

- Remove global `if (isStreaming) return;` guard from `sendMessage`
- Add per-conversation guard: `if (conversationId && streamStatesRef.current.has(conversationId)) return;`
- `isStreaming` exposed to ChatInput becomes: does the active conversation have an entry in `streamStatesRef`?
- `flushText` becomes `flushTextForStream(state: StreamState)` — operates on per-stream state

### 6. Stream Completion (onDone / onError)

1. Remove conversationId from `streamStatesRef` and `streamingConversationIds`
2. If user is viewing this conversation: update `setMessages` with final state, clear streaming indicators
3. If user is NOT viewing: backend has persisted the response. Delete stale cache so next switch fetches fresh data.

### 7. Sidebar Streaming Indicator

- New React state in AgentContext: `streamingConversationIds: Set<string>`
- Passed through `Sidebar` -> `ConversationHistory` as prop
- Visual: pulsing dot next to conversation title via CSS animation
- Updated on stream start (add) and stream end (remove)

### 8. editMessage and respondToQuestion

- `editMessage`: Creates a new StreamState (aborts any existing one for that conversation first)
- `respondToQuestion`: Accepts `conversationId` parameter to look up correct StreamState
- `deleteMessage`: Checks per-conversation streaming instead of global flag

## Files Changed

- `frontend/src/contexts/AgentContext.tsx` — major refactor (StreamState map, per-stream callbacks, re-attachment)
- `frontend/src/hooks/useAgent.ts` — add `streamingConversationIds` to context interface
- `frontend/src/components/ChatInput.tsx` — per-conversation `isStreaming` check
- `frontend/src/components/ConversationHistory.tsx` — streaming dot indicator
- `frontend/src/components/ConversationHistory.css` — pulse animation
- `frontend/src/components/Sidebar.tsx` — thread `streamingConversationIds` prop
- `frontend/src/App.tsx` — thread `streamingConversationIds` prop

## No Backend Changes

The backend already:
- Persists the complete response in the `finally` block (even if client disconnects)
- Doesn't track streaming state per conversation
- Supports concurrent SSE connections
