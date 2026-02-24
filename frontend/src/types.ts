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

export interface ToolCallResult {
  toolCallId: string;
  toolName?: string;
  sql: string;
  command?: string;
  toolInput?: Record<string, unknown>;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  error?: string;
  output?: string;
  rawContent?: string;
  chart_spec?: {
    data: unknown[];
    layout?: Record<string, unknown>;
  };
}

export interface SubagentEvent {
  id: string;
  name: string;
  prompt?: string;
  result?: string;
  chart_spec?: {
    data: unknown[];
    layout?: Record<string, unknown>;
  };
}

export interface ContentSegment {
  type: 'thinking' | 'tool' | 'answer' | 'subagent_start' | 'subagent_end';
  text?: string;
  toolResult?: ToolCallResult;
  subagentId?: string;
  subagentName?: string;
  chart_spec?: {
    data: unknown[];
    layout?: Record<string, unknown>;
  };
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCallResult[];
  segments?: ContentSegment[];
  isStreaming?: boolean;
  currentPhase?: 'thinking' | 'answer';
}

export interface LangfuseStatus {
  enabled: boolean;
  dashboardUrl: string | null;
}
