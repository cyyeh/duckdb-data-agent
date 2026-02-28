export interface AgentDefinitionPayload {
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
}

export interface QueryRequest {
  message: string;
  session_id?: string;
  system_prompt: string;
  model?: string;
  mcp_server_url?: string;
  env?: Record<string, string>;
  agents?: Record<string, AgentDefinitionPayload>;
  langfuse_session_id?: string;
  original_message?: string;
  conversation_history?: Array<{ role: string; content: string }>;
  skills?: string[];
}

export interface HealthResponse {
  status: "ok" | "error";
  message?: string;
}
