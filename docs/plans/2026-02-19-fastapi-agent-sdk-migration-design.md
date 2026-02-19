# Design: FastAPI + Claude Agent SDK Backend for DuckDB Data Agent

**Date:** 2026-02-19
**Status:** Approved

## Summary

Migrate the DuckDB Data Agent from a fully client-side architecture (browser DuckDB-WASM + direct Anthropic API calls) to a server-client architecture with a FastAPI backend using the Claude Agent SDK (Python). The frontend retains the same user experience but delegates all agent and database operations to the backend.

## Key Decisions

- **DuckDB location:** Server-side (Python `duckdb` package). Browser-side DuckDB-WASM removed.
- **Agent SDK:** Python `claude-agent-sdk` with `ClaudeSDKClient` for session-based conversations.
- **Custom tool:** `execute_sql` defined via `@tool` decorator as an MCP tool.
- **Streaming:** Server-Sent Events (SSE) from FastAPI to React frontend.
- **API key:** Environment variable (`ANTHROPIC_API_KEY` in `.env`), never exposed to frontend.
- **Package management:** Poetry for the Python backend.

## Architecture

```
┌─────────────────────────┐         ┌──────────────────────────────┐
│    React Frontend        │         │    FastAPI Backend            │
│    (Vite + TypeScript)   │         │    (Poetry + Python)         │
│                          │         │                              │
│  ┌────────────────────┐  │  POST   │  ┌────────────────────────┐  │
│  │  Agent Mode (Chat) │──┼────────►│  │  /api/chat             │  │
│  │  - ChatInput       │  │  SSE    │  │  - ClaudeSDKClient     │  │
│  │  - MessageBubble   │◄─┼────────┤  │  - Stream events       │  │
│  └────────────────────┘  │         │  └────────────────────────┘  │
│                          │         │              │               │
│  ┌────────────────────┐  │  POST   │  ┌───────────▼────────────┐  │
│  │  Editor Mode (SQL) │──┼────────►│  │  execute_sql MCP Tool  │  │
│  │  - QueryEditor     │  │  JSON   │  │  (via @tool decorator) │  │
│  │  - ResultsTable    │◄─┼────────┤  │                        │  │
│  └────────────────────┘  │         │  └───────────┬────────────┘  │
│                          │         │              │               │
│  ┌────────────────────┐  │  POST   │  ┌───────────▼────────────┐  │
│  │  File Upload       │──┼────────►│  │  DuckDB (Python)       │  │
│  │  - CSV files       │  │  multi- │  │  - In-memory database  │  │
│  └────────────────────┘  │  part   │  └────────────────────────┘  │
│                          │         │                              │
│  ┌────────────────────┐  │  GET    │  ┌────────────────────────┐  │
│  │  Sidebar (tables)  │──┼────────►│  │  /api/tables           │  │
│  └────────────────────┘  │         │  └────────────────────────┘  │
└─────────────────────────┘         └──────────────────────────────┘
```

## Project Structure

```
duckdb-data-agent/
├── backend/                          # NEW: FastAPI backend
│   ├── pyproject.toml                # Poetry project config
│   ├── .env                          # ANTHROPIC_API_KEY
│   └── app/
│       ├── __init__.py
│       ├── main.py                   # FastAPI app, CORS, routes
│       ├── config.py                 # Settings (env vars)
│       ├── database.py               # DuckDB session management
│       ├── tools.py                  # @tool execute_sql MCP tool
│       ├── agent.py                  # ClaudeSDKClient wrapper, streaming
│       └── routes/
│           ├── __init__.py
│           ├── chat.py               # POST /api/chat (SSE streaming)
│           ├── tables.py             # GET /api/tables, POST /api/upload
│           └── query.py              # POST /api/query (Editor mode SQL)
├── src/                              # MODIFIED: React frontend
│   ├── agent/
│   │   └── agentService.ts          # REWRITE: calls backend SSE endpoint
│   ├── components/                   # MOSTLY UNCHANGED UI
│   ├── App.tsx                       # MODIFY: remove API key dialog
│   ├── AgentContext.tsx              # MODIFY: remove apiKey, use backend
│   └── ...
├── package.json                      # MODIFY: remove duckdb-wasm deps
└── vite.config.ts                    # MODIFY: add proxy to backend
```

## API Endpoints

| Method | Endpoint | Purpose | Request | Response |
|--------|----------|---------|---------|----------|
| POST | `/api/chat` | Send message to agent | `{message, session_id?}` | SSE stream |
| POST | `/api/chat/cancel` | Cancel in-progress chat | `{session_id}` | `{ok: true}` |
| POST | `/api/upload` | Upload CSV file | multipart/form-data | `{table_name, columns, row_count}` |
| GET | `/api/tables` | List loaded tables | - | `[{name, columns, row_count}]` |
| POST | `/api/query` | Execute SQL (Editor) | `{sql}` | `{columns, rows, row_count}` |
| DELETE | `/api/tables/{name}` | Drop a table | - | `{ok: true}` |

## SSE Event Format

```
event: thinking
data: {"text": "Let me analyze..."}

event: tool_call
data: {"id": "tc_1", "sql": "SELECT * FROM users LIMIT 5"}

event: tool_result
data: {"id": "tc_1", "columns": [...], "rows": [...], "row_count": 5}

event: answer
data: {"text": "Based on the query results..."}

event: done
data: {"session_id": "sess_abc123"}

event: error
data: {"message": "Something went wrong"}
```

## Frontend Changes

**Removed:**
- `DuckDBContext.tsx`, `duckdb.ts`, `useDuckDB.ts`
- `@duckdb/duckdb-wasm`, `apache-arrow`, `@anthropic-ai/sdk` dependencies
- API key dialog in `App.tsx`
- `apiKey` state in `AgentContext.tsx`
- `systemPrompt.ts`, `tools.ts` from `agent/`

**Modified:**
- `agentService.ts` → calls `POST /api/chat`, parses SSE events
- `AgentContext.tsx` → no apiKey, sendMessage calls backend
- `FileUpload.tsx` → uploads to `POST /api/upload`
- `QueryEditor.tsx` / `App.tsx` → SQL via `POST /api/query`
- `Sidebar.tsx` → fetches tables from `GET /api/tables`
- `vite.config.ts` → proxy `/api` to FastAPI

**Unchanged:**
- `ChatInput.tsx`, `MessageBubble.tsx`, `ResultsTable.tsx`, `InlineQueryResult.tsx`
