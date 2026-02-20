# Langfuse Integration Design

## Goal

Add Langfuse observability tracing to the agent backend and a "Langfuse Traces" button to the agent mode UI. Langfuse is optional — when not configured, tracing is skipped with zero overhead and the button is shown disabled.

## Approach

**@observe decorator + manual spans** — wraps the existing `stream_chat()` function with Langfuse tracing. Each agent chat request produces one trace containing LLM generation spans and tool execution spans. No changes to the SSE streaming protocol.

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

New module that:

- Initializes Langfuse client only when `LANGFUSE_ENABLED` is True
- Verifies connection with `auth_check()` at startup (logs warning on failure)
- Exposes `get_langfuse_client()` returning the client or `None`
- Exposes `get_langfuse_dashboard_url()` returning the base URL or `None`

### 3. Agent Instrumentation (`backend/app/agent.py`)

Wrap `stream_chat()` with conditional Langfuse tracing:

**Trace hierarchy:**

```
Trace: "agent-chat"
  metadata: { session_id, model, user_message (truncated) }
  ├── Generation: "llm-turn-N"
  │   input: messages context
  │   output: thinking + text content
  │   usage: { input_tokens, output_tokens }
  ├── Span: "tool-execute_sql"
  │   input: { sql }
  │   output: { columns, rows (truncated), rowCount } or { error }
  └── (repeats for multi-turn agent loops)
```

Key constraints:
- Tracing is conditional — if `get_langfuse_client()` returns `None`, no spans are created
- Zero changes to the SSE event protocol
- Trace captures the session_id as the Langfuse session ID for grouping multi-turn conversations
- Tool results are truncated in traces to avoid sending large datasets to Langfuse

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

Add `langfuse` package.

## Frontend Changes

### 1. Langfuse Status Fetching (`frontend/src/App.tsx`)

On app load (alongside existing health check), fetch `GET /api/langfuse/status`. Store `{ enabled: boolean, dashboardUrl: string | null }` in state and pass to `AgentPanel`.

### 2. Langfuse Traces Button (`frontend/src/components/AgentPanel.tsx`)

Add "Langfuse Traces" button in the agent panel header, between the "Agent Mode" title and "Clear" button:

```
┌──────────────────────────────────────────────┐
│ Agent Mode    [Langfuse Traces ↗]    [Clear] │
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
