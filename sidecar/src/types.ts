export interface QueryRequest {
  message: string;
  session_id?: string;
  system_prompt: string;
  model?: string;
  mcp_server_url?: string;
  env?: Record<string, string>;
  langfuse_session_id?: string;
  original_message?: string;
  conversation_history?: Array<{ role: string; content: string }>;
}

export interface HealthResponse {
  status: "ok" | "error";
  message?: string;
}
