export interface ColumnInfo {
  name: string;
  type: string;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  rowCount: number;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  executionTimeMs: number;
  resultType: 'table' | 'markdown';
}

export interface ToolCallInfo {
  id: string;
  sql: string;
}

export interface ToolCallResult {
  toolCallId: string;
  sql: string;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  error?: string;
  rawContent?: string;
}

export interface ContentSegment {
  type: 'thinking' | 'tool' | 'answer';
  text?: string;
  toolResult?: ToolCallResult;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCallResult[];
  segments?: ContentSegment[];
  isStreaming?: boolean;
}
