import type { ToolCallResult } from '../types';

interface AgentCallbacks {
  onTextChunk: (text: string) => void;
  onThinkingDone: () => void;
  onToolCall: (pending: ToolCallResult) => void;
  onToolResult: (result: ToolCallResult) => void;
  onDone: (sessionId: string | null) => void;
  onError: (error: string) => void;
}

export type { AgentCallbacks };

async function streamSSE(
  response: Response,
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    callbacks.onError('No response stream');
    return;
  }

  let doneReceived = false;
  const wrappedCallbacks: AgentCallbacks = {
    ...callbacks,
    onDone: (sessionId) => {
      doneReceived = true;
      callbacks.onDone(sessionId);
    },
    onError: (error) => {
      doneReceived = true;
      callbacks.onError(error);
    },
  };

  try {
    const decoder = new TextDecoder();
    let buffer = '';
    let eventType = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          const data = line.slice(6);
          try {
            const parsed = JSON.parse(data);
            handleSSEEvent(eventType, parsed, wrappedCallbacks);
          } catch {
            // Skip malformed JSON
          }
          eventType = '';
        }
      }
    }

    // Process any remaining data left in buffer after stream ends
    if (buffer.trim()) {
      const remainingLines = buffer.split('\n');
      for (const line of remainingLines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          const data = line.slice(6);
          try {
            const parsed = JSON.parse(data);
            handleSSEEvent(eventType, parsed, wrappedCallbacks);
          } catch {
            // Skip malformed JSON
          }
          eventType = '';
        }
      }
    }

    // Safety net: if stream ended without done/error, force done
    if (!doneReceived) {
      callbacks.onDone(null);
    }
  } catch (e: unknown) {
    if (signal?.aborted) return;
    const msg = e instanceof Error ? e.message : 'Connection failed';
    callbacks.onError(msg);
  }
}

export async function runAgentLoop(
  message: string,
  agentSessionId: string | null,
  langfuseSessionId: string | null,
  conversationHistory: { role: string; content: string }[] | null,
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
  userSessionId?: string,
): Promise<void> {
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(userSessionId ? { 'X-Session-ID': userSessionId } : {}),
      },
      body: JSON.stringify({
        message,
        session_id: agentSessionId,
        langfuse_session_id: langfuseSessionId,
        conversation_history: conversationHistory ?? [],
      }),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      callbacks.onError(`Server error: ${errorText}`);
      return;
    }

    await streamSSE(response, callbacks, signal);
  } catch (e: unknown) {
    if (signal?.aborted) return;
    const msg = e instanceof Error ? e.message : 'Connection failed';
    callbacks.onError(msg);
  }
}

export async function runAgentEditLoop(
  newMessage: string,
  conversationHistory: { role: string; content: string }[],
  langfuseSessionId: string | null,
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
  userSessionId?: string,
): Promise<void> {
  try {
    const response = await fetch('/api/chat/edit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(userSessionId ? { 'X-Session-ID': userSessionId } : {}),
      },
      body: JSON.stringify({
        new_message: newMessage,
        conversation_history: conversationHistory,
        langfuse_session_id: langfuseSessionId,
      }),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      callbacks.onError(`Server error: ${errorText}`);
      return;
    }

    await streamSSE(response, callbacks, signal);
  } catch (e: unknown) {
    if (signal?.aborted) return;
    const msg = e instanceof Error ? e.message : 'Connection failed';
    callbacks.onError(msg);
  }
}

function handleSSEEvent(
  eventType: string,
  data: Record<string, unknown>,
  callbacks: AgentCallbacks,
) {
  switch (eventType) {
    case 'thinking':
    case 'answer':
      callbacks.onTextChunk(data.text as string);
      break;
    case 'thinking_done':
      callbacks.onThinkingDone();
      break;
    case 'tool_call':
      callbacks.onToolCall({
        toolCallId: (data.id as string) ?? '',
        toolName: (data.name as string) ?? undefined,
        sql: (data.sql as string) ?? '',
        command: (data.command as string) ?? undefined,
        toolInput: (data.input as Record<string, unknown>) ?? undefined,
        columns: [],
        rows: [],
        rowCount: 0,
      });
      break;
    case 'tool_result': {
      const result: ToolCallResult = {
        toolCallId: (data.id as string) ?? '',
        toolName: (data.name as string) ?? undefined,
        sql: (data.sql as string) ?? '',
        columns: (data.columns as string[]) ?? [],
        rows: (data.rows as Record<string, unknown>[]) ?? [],
        rowCount: (data.rowCount as number) ?? 0,
        error: (data.error as string) ?? undefined,
        output: (data.output as string) ?? undefined,
        rawContent: (data.content as string) ?? undefined,
        chart_spec: (data.chart_spec as { data: unknown[]; layout?: Record<string, unknown> }) ?? undefined,
      };
      callbacks.onToolResult(result);
      break;
    }
    case 'done':
      callbacks.onDone((data.session_id as string) ?? null);
      break;
    case 'error':
      callbacks.onError((data.message as string) ?? 'Unknown error');
      break;
  }
}
