# Langfuse Integration Design

## Goal

Add Langfuse observability tracing to the agent backend and a "Langfuse Traces" button to the agent mode UI. Langfuse is optional — when not configured, tracing is skipped with zero overhead and the button is shown disabled.

## Approach

**OpenTelemetry auto-instrumentation via langsmith** — uses `langsmith[claude-agent-sdk]` to automatically capture LLM calls, tool calls, and token usage via OTel. Langfuse receives traces through its OTel receiver. The `start_as_current_observation()` context manager creates the parent trace, and `propagate_attributes()` sets session/metadata. No manual generation or tool spans needed. No changes to the SSE streaming protocol.

## Backend Changes

### 1. Configuration (`backend/app/config.py`)

Add environment variables:

```python
LANGFUSE_PUBLIC_KEY = os.getenv("LANGFUSE_PUBLIC_KEY", "")
LANGFUSE_SECRET_KEY = os.getenv("LANGFUSE_SECRET_KEY", "")
LANGFUSE_BASE_URL = os.getenv("LANGFUSE_BASE_URL", "https://cloud.langfuse.com")
LANGFUSE_ENABLED = bool(LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY)
```

Update `backend/.env.example`:

```
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

### 2. Tracing Module (`backend/app/tracing.py`)

Module that:

- Uses `langfuse.get_client()` singleton (reads from env vars) when `LANGFUSE_ENABLED` is True
- Verifies connection with `auth_check()` at startup (logs warning on failure)
- Calls `configure_claude_agent_sdk()` from `langsmith.integrations.claude_agent_sdk` to enable auto-instrumentation
- Sets OTel env vars (`LANGSMITH_OTEL_ENABLED`, `LANGSMITH_OTEL_ONLY`, `LANGSMITH_TRACING`) programmatically
- Exposes `get_langfuse_client()` returning the client or `None`
- Exposes `get_langfuse_dashboard_url()` returning the project traces URL or `None`

### 3. Agent Instrumentation (`backend/app/agent.py`)

Minimal tracing context in `stream_chat()` — auto-instrumentation handles the rest:

- `start_as_current_observation()` creates the parent "agent-chat" observation
- `propagate_attributes()` sets session_id for trace grouping
- `update_current_trace()` records trace output
- `flush()` ensures traces are sent before response ends

LLM generations, tool calls, and token usage are automatically captured by the langsmith integration. No manual generation or tool spans needed.

Key constraints:
- Tracing is conditional — if `get_langfuse_client()` returns `None`, no context is created
- Zero changes to the SSE event protocol
- SQL execution for frontend display remains unchanged (auto-instrumentation captures MCP execution separately)

### 4. API Endpoint (`backend/app/routes/langfuse.py`)

```
GET /api/langfuse/status
Response: { "enabled": true, "dashboardUrl": "https://cloud.langfuse.com" }
       or { "enabled": false, "dashboardUrl": null }
```

No secrets exposed. Called once by frontend on app load.

### 5. App Setup (`backend/app/main.py`)

Register the new langfuse router.

### 6. Dependencies (`backend/pyproject.toml`)

Add `langfuse` and `langsmith[claude-agent-sdk,otel]` packages.

## Frontend Changes

### 1. Langfuse Status Fetching (`frontend/src/App.tsx`)

On app load (alongside existing health check), fetch `GET /api/langfuse/status`. Store `{ enabled: boolean, dashboardUrl: string | null }` in state and pass to `AgentPanel`.

### 2. Langfuse Traces Button (`frontend/src/components/AgentPanel.tsx`)

Add "Langfuse Traces" button in the agent panel header, between the "Agent Mode" title and "Clear" button:

```
┌──────────────────────────────────────────────┐
│ Agent Mode    [Langfuse Traces]    [Clear] │
├──────────────────────────────────────────────┤
```

Button states:
- **Enabled** (Langfuse configured): Subtle link-style button, opens `dashboardUrl` in new tab
- **Disabled** (Langfuse not configured): Grayed out, tooltip "Langfuse not configured"

### 3. Styles (`frontend/src/components/AgentPanel.css`)

Add styles for the Langfuse button in both enabled and disabled states. Match existing design language (small text, gray tones, subtle borders).

## Files Changed

| File | Change |
|---|---|
| `backend/app/config.py` | Add Langfuse env vars |
| `backend/app/tracing.py` | **New** — Langfuse client wrapper |
| `backend/app/agent.py` | Add conditional tracing spans |
| `backend/app/routes/langfuse.py` | **New** — status endpoint |
| `backend/app/main.py` | Register langfuse router |
| `backend/pyproject.toml` | Add langfuse dependency |
| `backend/.env.example` | Add Langfuse vars |
| `frontend/src/App.tsx` | Fetch Langfuse status, pass to AgentPanel |
| `frontend/src/components/AgentPanel.tsx` | Add Langfuse Traces button |
| `frontend/src/components/AgentPanel.css` | Button styles |
