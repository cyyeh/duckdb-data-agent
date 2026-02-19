import type { ToolCallResult } from '../types';

interface AgentCallbacks {
  onTextChunk: (text: string) => void;
  onToolCall: (toolCallId: string, sql: string) => void;
  onToolResult: (result: ToolCallResult) => void;
  onDone: (sessionId: string | null) => void;
  onError: (error: string) => void;
}

export async function runAgentLoop(
  message: string,
  sessionId: string | null,
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, session_id: sessionId }),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      callbacks.onError(`Server error: ${errorText}`);
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      callbacks.onError('No response stream');
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      let eventType = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          const data = line.slice(6);
          try {
            const parsed = JSON.parse(data);
            handleSSEEvent(eventType, parsed, callbacks);
          } catch {
            // Skip malformed JSON
          }
          eventType = '';
        }
      }
    }
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
    case 'tool_call':
      callbacks.onToolCall(data.id as string, data.sql as string);
      break;
    case 'tool_result': {
      const result: ToolCallResult = {
        toolCallId: (data.id as string) ?? '',
        sql: (data.sql as string) ?? '',
        columns: (data.columns as string[]) ?? [],
        rows: (data.rows as Record<string, unknown>[]) ?? [],
        rowCount: (data.rowCount as number) ?? 0,
        error: (data.error as string) ?? undefined,
        rawContent: (data.content as string) ?? undefined,
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
