export interface QueryRequest {
  message: string;
  session_id?: string;
  system_prompt: string;
  model?: string;
  mcp_server_url?: string;
  env?: Record<string, string>;
}

export interface HealthResponse {
  status: "ok" | "error";
  message?: string;
}
