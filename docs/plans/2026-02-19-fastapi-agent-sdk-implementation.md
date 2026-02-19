# FastAPI + Claude Agent SDK Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate the DuckDB data agent from a fully client-side architecture to a FastAPI backend using the Python Claude Agent SDK, while keeping the React frontend UX identical.

**Architecture:** FastAPI backend with Poetry manages DuckDB (Python), exposes REST+SSE endpoints. Claude Agent SDK (`claude-agent-sdk`) with custom `execute_sql` MCP tool handles the agent loop. React frontend calls backend APIs instead of browser-side DuckDB/Anthropic SDK.

**Tech Stack:** Python 3.12+, Poetry, FastAPI, uvicorn, duckdb (Python), claude-agent-sdk, python-dotenv, python-multipart. Frontend: React 18, Vite, TypeScript (unchanged).

---

### Task 1: Initialize Python Backend with Poetry

**Files:**
- Create: `backend/pyproject.toml`
- Create: `backend/app/__init__.py`
- Create: `backend/app/main.py`
- Create: `backend/.env`
- Create: `backend/.gitignore`

**Step 1: Create the backend directory structure**

```bash
mkdir -p backend/app/routes
```

**Step 2: Initialize Poetry project**

```bash
cd backend
poetry init --name duckdb-data-agent-backend --python "^3.12" --no-interaction
```

**Step 3: Add dependencies**

```bash
cd backend
poetry add fastapi uvicorn[standard] duckdb claude-agent-sdk python-dotenv python-multipart
```

**Step 4: Create `backend/.env`**

```
ANTHROPIC_API_KEY=your-api-key-here
```

**Step 5: Create `backend/.gitignore`**

```
__pycache__/
*.pyc
.env
.venv/
```

**Step 6: Create `backend/app/__init__.py`**

Empty file.

**Step 7: Create `backend/app/main.py` with minimal FastAPI app**

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="DuckDB Data Agent API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health():
    return {"status": "ok"}
```

**Step 8: Verify the server starts**

```bash
cd backend
poetry run uvicorn app.main:app --reload --port 8000
```

Visit `http://localhost:8000/api/health` — expect `{"status": "ok"}`.

**Step 9: Commit**

```bash
git add backend/
git commit -m "feat: initialize FastAPI backend with Poetry"
```

---

### Task 2: Implement DuckDB Database Module

**Files:**
- Create: `backend/app/database.py`

**Step 1: Create `backend/app/database.py`**

This module manages a single in-memory DuckDB connection. It handles CSV uploads, table listing, and SQL execution.

```python
import duckdb
import os
import tempfile
from typing import Any


class Database:
    def __init__(self):
        self.conn = duckdb.connect(":memory:")

    def execute_query(self, sql: str) -> dict[str, Any]:
        """Execute a SQL query and return results as dict with columns, rows, rowCount."""
        result = self.conn.execute(sql)
        columns = [desc[0] for desc in result.description] if result.description else []
        rows = [dict(zip(columns, row)) for row in result.fetchall()] if columns else []
        return {"columns": columns, "rows": rows, "rowCount": len(rows)}

    def load_csv(self, file_bytes: bytes, filename: str, table_name: str) -> dict[str, Any]:
        """Load a CSV file into a DuckDB table. Returns table info."""
        with tempfile.NamedTemporaryFile(suffix=".csv", delete=False) as tmp:
            tmp.write(file_bytes)
            tmp_path = tmp.name
        try:
            self.conn.execute(
                f'CREATE OR REPLACE TABLE "{table_name}" AS SELECT * FROM read_csv_auto(\'{tmp_path}\')'
            )
        finally:
            os.unlink(tmp_path)
        return self.get_table_info(table_name)

    def get_table_info(self, table_name: str) -> dict[str, Any]:
        """Get info about a specific table."""
        cols_result = self.conn.execute(f'DESCRIBE "{table_name}"')
        columns = [
            {"name": row[0], "type": row[1]}
            for row in cols_result.fetchall()
        ]
        count_result = self.conn.execute(f'SELECT COUNT(*) FROM "{table_name}"')
        row_count = count_result.fetchone()[0]
        return {"name": table_name, "columns": columns, "rowCount": row_count}

    def list_tables(self) -> list[dict[str, Any]]:
        """List all tables with their schema info."""
        tables_result = self.conn.execute("SHOW TABLES")
        table_names = [row[0] for row in tables_result.fetchall()]
        return [self.get_table_info(name) for name in table_names]

    def drop_table(self, table_name: str) -> None:
        """Drop a table."""
        self.conn.execute(f'DROP TABLE IF EXISTS "{table_name}"')

    def load_sample_data(self, csv_path: str, table_name: str) -> dict[str, Any]:
        """Load sample CSV from a file path."""
        self.conn.execute(
            f'CREATE OR REPLACE TABLE "{table_name}" AS SELECT * FROM read_csv_auto(\'{csv_path}\')'
        )
        return self.get_table_info(table_name)


# Singleton instance
db = Database()
```

**Step 2: Verify module imports correctly**

```bash
cd backend
poetry run python -c "from app.database import db; print(db.list_tables())"
```

Expected: `[]`

**Step 3: Commit**

```bash
git add backend/app/database.py
git commit -m "feat: add DuckDB database module with CSV loading and query execution"
```

---

### Task 3: Implement Table and Query API Routes

**Files:**
- Create: `backend/app/routes/__init__.py`
- Create: `backend/app/routes/tables.py`
- Create: `backend/app/routes/query.py`
- Modify: `backend/app/main.py` (register routers)

**Step 1: Create `backend/app/routes/__init__.py`**

Empty file.

**Step 2: Create `backend/app/routes/tables.py`**

```python
import re

from fastapi import APIRouter, UploadFile, File, HTTPException

from app.database import db

router = APIRouter(prefix="/api", tags=["tables"])


def sanitize_table_name(filename: str) -> str:
    base = re.sub(r"\.csv$", "", filename, flags=re.IGNORECASE)
    sanitized = re.sub(r"[^a-z0-9_]", "_", base.lower())
    sanitized = re.sub(r"^[^a-z]", lambda m: "t_" + m.group(), sanitized)
    sanitized = re.sub(r"_+", "_", sanitized).rstrip("_")
    return sanitized or "table"


@router.get("/tables")
async def list_tables():
    return db.list_tables()


@router.post("/upload")
async def upload_csv(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Only CSV files are supported")
    content = await file.read()
    table_name = sanitize_table_name(file.filename)
    result = db.load_csv(content, file.filename, table_name)
    return result


@router.post("/upload/sample")
async def load_sample():
    """Load the built-in Titanic sample dataset."""
    import urllib.request
    import tempfile
    import os

    # Download titanic.csv from the public directory (or bundle it)
    # For now, use a simple approach: download from a known URL or local path
    sample_url = "https://raw.githubusercontent.com/datasciencedojo/datasets/master/titanic.csv"
    with tempfile.NamedTemporaryFile(suffix=".csv", delete=False) as tmp:
        urllib.request.urlretrieve(sample_url, tmp.name)
        tmp_path = tmp.name
    try:
        result = db.load_sample_data(tmp_path, "titanic")
    finally:
        os.unlink(tmp_path)
    return result


@router.delete("/tables/{table_name}")
async def drop_table(table_name: str):
    db.drop_table(table_name)
    return {"ok": True}
```

**Step 3: Create `backend/app/routes/query.py`**

```python
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.database import db

router = APIRouter(prefix="/api", tags=["query"])


class QueryRequest(BaseModel):
    sql: str


@router.post("/query")
async def execute_query(request: QueryRequest):
    try:
        result = db.execute_query(request.sql)
        sql_lower = request.sql.strip().lower()
        result_type = "markdown" if sql_lower.startswith("explain") else "table"
        return {**result, "resultType": result_type}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
```

**Step 4: Register routers in `backend/app/main.py`**

Update `main.py` to include:

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routes import tables, query

app = FastAPI(title="DuckDB Data Agent API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(tables.router)
app.include_router(query.router)


@app.get("/api/health")
async def health():
    return {"status": "ok"}
```

**Step 5: Verify endpoints**

```bash
cd backend
poetry run uvicorn app.main:app --reload --port 8000
# In another terminal:
curl http://localhost:8000/api/tables
# Expected: []
curl -X POST http://localhost:8000/api/query -H "Content-Type: application/json" -d '{"sql": "SELECT 1 as test"}'
# Expected: {"columns":["test"],"rows":[{"test":1}],"rowCount":1,"resultType":"table"}
```

**Step 6: Commit**

```bash
git add backend/app/routes/ backend/app/main.py
git commit -m "feat: add table management and SQL query API endpoints"
```

---

### Task 4: Implement Agent Chat with Claude Agent SDK

**Files:**
- Create: `backend/app/config.py`
- Create: `backend/app/tools.py`
- Create: `backend/app/agent.py`
- Create: `backend/app/routes/chat.py`
- Modify: `backend/app/main.py` (register chat router)

**Step 1: Create `backend/app/config.py`**

```python
import os
from dotenv import load_dotenv

load_dotenv()

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
```

**Step 2: Create `backend/app/tools.py`**

This defines the custom MCP tool for SQL execution that the Agent SDK will use.

```python
from typing import Any
from claude_agent_sdk import tool, create_sdk_mcp_server
from app.database import db

MAX_RESULT_ROWS = 100


@tool("execute_sql", "Execute a SQL query against the DuckDB database. Use this to query loaded tables, create views, or run any valid DuckDB SQL. Results are returned as JSON with columns, rows, and rowCount.", {"sql": str})
async def execute_sql(args: dict[str, Any]) -> dict[str, Any]:
    sql = args["sql"]
    try:
        result = db.execute_query(sql)
        truncated_rows = result["rows"][:MAX_RESULT_ROWS]
        content_text = f"Query executed successfully.\nColumns: {result['columns']}\nRows returned: {len(truncated_rows)} of {result['rowCount']}\n\nResults:\n"
        for row in truncated_rows:
            content_text += str(row) + "\n"
        if result["rowCount"] > MAX_RESULT_ROWS:
            content_text += f"\n(Showing first {MAX_RESULT_ROWS} of {result['rowCount']} rows)"
        return {"content": [{"type": "text", "text": content_text}]}
    except Exception as e:
        return {
            "content": [{"type": "text", "text": f"SQL Error: {str(e)}"}],
            "is_error": True,
        }


def create_duckdb_server():
    return create_sdk_mcp_server(
        name="duckdb",
        version="1.0.0",
        tools=[execute_sql],
    )
```

**Step 3: Create `backend/app/agent.py`**

This module wraps the Agent SDK to provide streaming chat. It uses `ClaudeSDKClient` with `include_partial_messages=True` to stream events.

```python
import json
import asyncio
from typing import AsyncIterator

from claude_agent_sdk import (
    ClaudeSDKClient,
    ClaudeAgentOptions,
    AssistantMessage,
    ResultMessage,
    StreamEvent,
    TextBlock,
    ToolUseBlock,
    ToolResultBlock,
)
from app.tools import create_duckdb_server
from app.database import db


def build_system_prompt() -> str:
    tables = db.list_tables()
    prompt = """You are a helpful data analyst assistant working with a DuckDB database.
You can execute SQL queries using the execute_sql tool to answer questions about the user's data.

Guidelines:
- Write clear, efficient DuckDB SQL queries
- When exploring data, start with small queries (use LIMIT)
- Explain your findings in plain language after getting results
- If a query fails, try to fix it and retry
- Use double quotes for table and column names that might conflict with reserved words
"""
    if not tables:
        prompt += "\nNo tables are currently loaded. Ask the user to upload a CSV file first."
    else:
        prompt += "\nCurrently loaded tables:\n"
        for table in tables:
            prompt += f'\nTable: "{table["name"]}" ({table["rowCount"]} rows)\nColumns:\n'
            for col in table["columns"]:
                prompt += f'  - "{col["name"]}" ({col["type"]})\n'
    return prompt


async def stream_chat(message: str, session_id: str | None = None) -> AsyncIterator[str]:
    """Stream agent chat responses as SSE events."""
    duckdb_server = create_duckdb_server()

    options = ClaudeAgentOptions(
        system_prompt=build_system_prompt(),
        mcp_servers={"duckdb": duckdb_server},
        allowed_tools=["mcp__duckdb__execute_sql"],
        permission_mode="bypassPermissions",
        max_turns=20,
        include_partial_messages=True,
    )

    client = ClaudeSDKClient(options=options)
    actual_session_id = session_id

    try:
        if session_id:
            await client.connect()
            await client.query(message, session_id=session_id)
        else:
            await client.connect(prompt=message)

        current_text = ""
        has_tool_calls = False
        thinking_sent = False

        async for msg in client.receive_messages():
            if isinstance(msg, StreamEvent):
                # Handle streaming events for real-time text display
                event = msg.event
                if not actual_session_id:
                    actual_session_id = msg.session_id

                event_type = event.get("type", "")

                if event_type == "content_block_delta":
                    delta = event.get("delta", {})
                    delta_type = delta.get("type", "")
                    if delta_type == "text_delta":
                        text = delta.get("text", "")
                        current_text += text
                        # Determine if this is thinking or answer phase
                        event_name = "thinking" if not has_tool_calls else "answer"
                        yield f"event: {event_name}\ndata: {json.dumps({'text': text})}\n\n"

                elif event_type == "content_block_start":
                    block = event.get("content_block", {})
                    if block.get("type") == "tool_use":
                        # A tool call is starting
                        if current_text.strip() and not thinking_sent:
                            thinking_sent = True
                        has_tool_calls = True

            elif isinstance(msg, AssistantMessage):
                if not actual_session_id:
                    actual_session_id = "default"

                for block in msg.content:
                    if isinstance(block, ToolUseBlock):
                        sql = block.input.get("sql", "")
                        yield f"event: tool_call\ndata: {json.dumps({'id': block.id, 'sql': sql})}\n\n"
                        has_tool_calls = True

                    elif isinstance(block, ToolResultBlock):
                        # Parse tool result to extract structured data
                        try:
                            content_str = block.content if isinstance(block.content, str) else str(block.content)
                            yield f"event: tool_result\ndata: {json.dumps({'id': block.tool_use_id, 'content': content_str})}\n\n"
                        except Exception:
                            yield f"event: tool_result\ndata: {json.dumps({'id': block.tool_use_id, 'content': 'Result received'})}\n\n"

            elif isinstance(msg, ResultMessage):
                actual_session_id = msg.session_id
                if msg.is_error and msg.result:
                    yield f"event: error\ndata: {json.dumps({'message': msg.result})}\n\n"
                yield f"event: done\ndata: {json.dumps({'session_id': actual_session_id})}\n\n"
                break

    except Exception as e:
        yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"
    finally:
        try:
            await client.disconnect()
        except Exception:
            pass
```

**Step 4: Create `backend/app/routes/chat.py`**

```python
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.agent import stream_chat

router = APIRouter(prefix="/api", tags=["chat"])


class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None


@router.post("/chat")
async def chat(request: ChatRequest):
    return StreamingResponse(
        stream_chat(request.message, request.session_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
```

**Step 5: Register chat router in `backend/app/main.py`**

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routes import tables, query, chat

app = FastAPI(title="DuckDB Data Agent API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(tables.router)
app.include_router(query.router)
app.include_router(chat.router)


@app.get("/api/health")
async def health():
    return {"status": "ok"}
```

**Step 6: Verify agent chat endpoint starts (manual test)**

```bash
cd backend
poetry run uvicorn app.main:app --reload --port 8000
# Test with curl (will require valid ANTHROPIC_API_KEY in .env):
curl -N -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, what tables are available?"}'
```

**Step 7: Commit**

```bash
git add backend/app/config.py backend/app/tools.py backend/app/agent.py backend/app/routes/chat.py backend/app/main.py
git commit -m "feat: add Claude Agent SDK chat endpoint with SSE streaming"
```

---

### Task 5: Update Vite Config for Backend Proxy

**Files:**
- Modify: `vite.config.ts`

**Step 1: Update `vite.config.ts` to proxy `/api` to the backend**

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

export default defineConfig({
  base: '/duckdb-data-agent/',
  plugins: [react()],
  build: {
    target: 'esnext',
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
```

Note: Removed `optimizeDeps.exclude` for `@duckdb/duckdb-wasm` since we're removing that dependency.

**Step 2: Commit**

```bash
git add vite.config.ts
git commit -m "feat: add Vite dev proxy for FastAPI backend"
```

---

### Task 6: Rewrite `agentService.ts` to Use Backend SSE

**Files:**
- Rewrite: `src/agent/agentService.ts`
- Delete: `src/agent/systemPrompt.ts`
- Delete: `src/agent/tools.ts`

**Step 1: Rewrite `src/agent/agentService.ts`**

Replace the entire file. This version calls the backend SSE endpoint instead of the Anthropic API directly.

```typescript
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
      // Parse tool result from agent
      const result: ToolCallResult = {
        toolCallId: (data.id as string) ?? '',
        sql: '',
        columns: [],
        rows: [],
        rowCount: 0,
      };
      // Try to extract structured data from content
      const content = data.content as string;
      if (content) {
        // The tool result content is text - we display it as metadata
        // The actual structured results come from the execute_sql tool
      }
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
```

**Step 2: Delete `src/agent/systemPrompt.ts`**

```bash
rm src/agent/systemPrompt.ts
```

**Step 3: Delete `src/agent/tools.ts`**

```bash
rm src/agent/tools.ts
```

**Step 4: Commit**

```bash
git add src/agent/agentService.ts
git rm src/agent/systemPrompt.ts src/agent/tools.ts
git commit -m "feat: rewrite agentService to use backend SSE, remove client-side agent code"
```

---

### Task 7: Rewrite `AgentContext.tsx` to Remove API Key and Use Backend

**Files:**
- Rewrite: `src/AgentContext.tsx`

**Step 1: Rewrite `src/AgentContext.tsx`**

Remove all API key handling, DuckDB context dependency, and Anthropic SDK imports. Call the new `runAgentLoop` which talks to the backend.

```typescript
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { runAgentLoop } from './agent/agentService';
import type { ChatMessage, ContentSegment, TableInfo, ToolCallResult } from './types';

interface AgentContextValue {
  messages: ChatMessage[];
  isStreaming: boolean;
  sendMessage: (text: string) => void;
  clearMessages: () => void;
}

const AgentContext = createContext<AgentContextValue>({
  messages: [],
  isStreaming: false,
  sendMessage: () => {},
  clearMessages: () => {},
});

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

export function AgentProvider({
  children,
  refreshTables,
}: {
  children: ReactNode;
  tables: TableInfo[];
  refreshTables: () => Promise<void>;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const textBufferRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const assistantIdRef = useRef('');
  const segmentsRef = useRef<ContentSegment[]>([]);
  const currentTextRef = useRef('');
  const sessionIdRef = useRef<string | null>(null);

  const flushText = useCallback(() => {
    const text = textBufferRef.current;
    if (!text) return;
    const id = assistantIdRef.current;
    currentTextRef.current += text;
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id ? { ...m, content: m.content + text } : m
      )
    );
    textBufferRef.current = '';
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      if (isStreaming) return;

      const userMsg: ChatMessage = {
        id: generateId(),
        role: 'user',
        content: text,
      };

      const assistantId = generateId();
      assistantIdRef.current = assistantId;
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        toolCalls: [],
        isStreaming: true,
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);
      textBufferRef.current = '';
      segmentsRef.current = [];
      currentTextRef.current = '';

      const controller = new AbortController();
      abortRef.current = controller;

      await runAgentLoop(
        text,
        sessionIdRef.current,
        {
          onTextChunk: (chunk) => {
            textBufferRef.current += chunk;
            if (!flushTimerRef.current) {
              flushTimerRef.current = setTimeout(() => {
                flushText();
                flushTimerRef.current = null;
              }, 50);
            }
          },
          onToolCall: (_toolCallId, _sql) => {
            if (flushTimerRef.current) {
              clearTimeout(flushTimerRef.current);
              flushTimerRef.current = null;
            }
            flushText();
            if (currentTextRef.current.trim()) {
              segmentsRef.current.push({ type: 'thinking', text: currentTextRef.current });
              currentTextRef.current = '';
            }
          },
          onToolResult: (result: ToolCallResult) => {
            segmentsRef.current.push({ type: 'tool', toolResult: result });
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, toolCalls: [...(m.toolCalls || []), result], segments: [...segmentsRef.current] }
                  : m
              )
            );
            refreshTables();
          },
          onDone: (newSessionId) => {
            if (newSessionId) sessionIdRef.current = newSessionId;
            if (flushTimerRef.current) {
              clearTimeout(flushTimerRef.current);
              flushTimerRef.current = null;
            }
            flushText();
            if (currentTextRef.current.trim()) {
              segmentsRef.current.push({
                type: 'answer',
                text: currentTextRef.current,
              });
              currentTextRef.current = '';
            }
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, isStreaming: false, segments: [...segmentsRef.current] }
                  : m
              )
            );
            setIsStreaming(false);
            abortRef.current = null;
          },
          onError: (error) => {
            if (flushTimerRef.current) {
              clearTimeout(flushTimerRef.current);
              flushTimerRef.current = null;
            }
            flushText();
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, content: m.content + `\n\n**Error:** ${error}`, isStreaming: false }
                  : m
              )
            );
            setIsStreaming(false);
            abortRef.current = null;
          },
        },
        controller.signal
      );
    },
    [isStreaming, messages, flushText, refreshTables]
  );

  const clearMessages = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    setMessages([]);
    setIsStreaming(false);
    sessionIdRef.current = null;
  }, []);

  return (
    <AgentContext.Provider
      value={{ messages, isStreaming, sendMessage, clearMessages }}
    >
      {children}
    </AgentContext.Provider>
  );
}

export function useAgent() {
  return useContext(AgentContext);
}
```

**Step 2: Commit**

```bash
git add src/AgentContext.tsx
git commit -m "feat: rewrite AgentContext to use backend API, remove API key handling"
```

---

### Task 8: Rewrite `App.tsx` to Remove DuckDB and API Key Dialog

**Files:**
- Rewrite: `src/App.tsx`

**Step 1: Rewrite `src/App.tsx`**

Remove all DuckDB-related code, API key dialog, and `useDuckDB` usage. All data operations now go through the backend API.

```typescript
import { useState, useCallback, useEffect } from 'react';
import { AgentProvider, useAgent } from './AgentContext';
import { FileUpload } from './components/FileUpload';
import { QueryEditor } from './components/QueryEditor';
import { ResultsTable } from './components/ResultsTable';
import { ResultMarkdown } from './components/ResultMarkdown';
import { Sidebar } from './components/Sidebar';
import { ErrorMessage } from './components/ErrorMessage';
import { AgentPanel } from './components/AgentPanel';
import type { TableInfo, QueryResult } from './types';
import './App.css';

function AppContent({ tables, refreshTables }: { tables: TableInfo[]; refreshTables: () => Promise<void> }) {
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editorQuery, setEditorQuery] = useState<string | undefined>(undefined);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);

  const handleAgentToggle = () => {
    setAgentOpen((prev) => !prev);
  };

  const handleLoadSample = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch('/api/upload/sample', { method: 'POST' });
      if (!response.ok) throw new Error('Failed to load sample dataset');
      await refreshTables();
      setEditorQuery('SELECT * FROM "titanic" LIMIT 100');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load sample dataset');
    }
  }, [refreshTables]);

  const handleFileUpload = useCallback(
    async (file: File) => {
      setError(null);
      try {
        const formData = new FormData();
        formData.append('file', file);
        const response = await fetch('/api/upload', {
          method: 'POST',
          body: formData,
        });
        if (!response.ok) throw new Error('Failed to upload file');
        const result = await response.json();
        await refreshTables();
        setEditorQuery(`SELECT * FROM "${result.name}" LIMIT 100`);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to upload file');
      }
    },
    [refreshTables]
  );

  const handleQueryExecute = useCallback(
    async (sql: string) => {
      setError(null);
      setQueryResult(null);
      try {
        const start = performance.now();
        const response = await fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql }),
        });
        const elapsed = performance.now() - start;

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.detail || 'Query execution failed');
        }

        const result = await response.json();
        setQueryResult({
          columns: result.columns,
          rows: result.rows,
          rowCount: result.rowCount,
          executionTimeMs: elapsed,
          resultType: result.resultType,
        });
        await refreshTables();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Query execution failed');
      }
    },
    [refreshTables]
  );

  const handleTableClick = useCallback((tableName: string) => {
    setEditorQuery(`SELECT * FROM "${tableName}" LIMIT 100`);
  }, []);

  const appClass = [
    'app',
    sidebarCollapsed ? 'app--sidebar-collapsed' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={appClass}>
      <div className="app__sidebar-wrapper">
        <Sidebar tables={tables} onTableClick={handleTableClick} collapsed={sidebarCollapsed} />
        <button
          className="app__sidebar-toggle"
          onClick={() => setSidebarCollapsed((prev) => !prev)}
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {sidebarCollapsed ? '\u25B6' : '\u25C0'}
        </button>
      </div>
      {agentOpen ? (
        <div className="app__agent-wrapper">
          <div className="app__header">
            <h1 className="app__title">DuckDB Data Agent</h1>
            <button
              className="app__agent-toggle app__agent-toggle--active"
              onClick={handleAgentToggle}
            >
              Editor Mode
            </button>
          </div>
          <AgentPanel />
        </div>
      ) : (
        <main className="app__main">
          <div className="app__header">
            <h1 className="app__title">DuckDB Data Agent</h1>
            <button
              className="app__agent-toggle"
              onClick={handleAgentToggle}
            >
              Agent Mode
            </button>
          </div>
          <FileUpload onUpload={handleFileUpload} onLoadSample={handleLoadSample} />
          <QueryEditor
            onExecute={handleQueryExecute}
            initialQuery={editorQuery}
          />
          {error && (
            <ErrorMessage message={error} onDismiss={() => setError(null)} />
          )}
          {queryResult?.resultType === 'markdown' ? (
            <ResultMarkdown result={queryResult} />
          ) : (
            <ResultsTable result={queryResult} />
          )}
        </main>
      )}
    </div>
  );
}

export default function App() {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshTables = useCallback(async () => {
    try {
      const response = await fetch('/api/tables');
      if (!response.ok) throw new Error('Failed to fetch tables');
      const data = await response.json();
      setTables(data);
    } catch (e) {
      console.error('Failed to refresh tables:', e);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const response = await fetch('/api/health');
        if (!response.ok) throw new Error('Backend is not available');
        await refreshTables();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to connect to backend');
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshTables]);

  if (loading) {
    return <div className="app-loading">Connecting to backend...</div>;
  }

  if (error) {
    return (
      <div className="app-error">Failed to connect: {error}</div>
    );
  }

  return (
    <AgentProvider tables={tables} refreshTables={refreshTables}>
      <AppContent tables={tables} refreshTables={refreshTables} />
    </AgentProvider>
  );
}
```

**Step 2: Commit**

```bash
git add src/App.tsx
git commit -m "feat: rewrite App.tsx to use backend API, remove API key dialog and DuckDB"
```

---

### Task 9: Update `main.tsx` and Remove DuckDB Client-Side Files

**Files:**
- Modify: `src/main.tsx`
- Delete: `src/DuckDBContext.tsx`
- Delete: `src/duckdb.ts`
- Delete: `src/useDuckDB.ts`

**Step 1: Rewrite `src/main.tsx`**

Remove `DuckDBProvider` wrapper.

```typescript
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

**Step 2: Delete DuckDB client-side files**

```bash
rm src/DuckDBContext.tsx src/duckdb.ts src/useDuckDB.ts
```

**Step 3: Commit**

```bash
git add src/main.tsx
git rm src/DuckDBContext.tsx src/duckdb.ts src/useDuckDB.ts
git commit -m "feat: remove DuckDB client-side code, simplify main.tsx"
```

---

### Task 10: Update `package.json` — Remove Unused Dependencies

**Files:**
- Modify: `package.json`

**Step 1: Remove DuckDB and Anthropic SDK dependencies**

```bash
npm uninstall @anthropic-ai/sdk @duckdb/duckdb-wasm apache-arrow
```

**Step 2: Verify the frontend still builds**

```bash
npm run build
```

Fix any remaining TypeScript errors (likely import references to removed modules).

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: remove @anthropic-ai/sdk, @duckdb/duckdb-wasm, apache-arrow dependencies"
```

---

### Task 11: Remove API Key CSS and Clean Up `App.css`

**Files:**
- Modify: `src/App.css`

**Step 1: Remove API key dialog CSS from `src/App.css`**

Remove lines 118-206 (all `.api-key-dialog*` rules):

```css
/* DELETE everything from .api-key-dialog__overlay through .api-key-dialog__save:disabled */
```

**Step 2: Commit**

```bash
git add src/App.css
git commit -m "chore: remove API key dialog CSS"
```

---

### Task 12: End-to-End Integration Test

**Files:** None (manual testing)

**Step 1: Start the backend**

```bash
cd backend
# Make sure .env has a valid ANTHROPIC_API_KEY
poetry run uvicorn app.main:app --reload --port 8000
```

**Step 2: Start the frontend**

```bash
# In the project root
npm run dev
```

**Step 3: Test Editor Mode**

1. Open `http://localhost:5173/duckdb-data-agent/`
2. Click "Load Sample Dataset (Titanic)" — should load via backend
3. Verify sidebar shows "titanic" table with columns
4. Run `SELECT * FROM "titanic" LIMIT 10` in the editor — should show results
5. Upload a custom CSV file — should create a new table

**Step 4: Test Agent Mode**

1. Click "Agent Mode" — should switch directly (no API key dialog)
2. Type "What tables are available?" — should stream a response
3. Type "Show me the first 5 rows of the titanic table" — should see thinking, SQL tool call, then answer
4. Verify the collapsible thinking block, inline query results, and answer segments all render correctly

**Step 5: Test edge cases**

1. Clear chat and send a new message
2. Switch between Editor and Agent modes
3. Upload a file while in Agent mode, switch to Editor to verify it's there
4. Run an invalid SQL query to verify error handling

**Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix: integration test fixes"
```

---

### Task 13: Final Cleanup and Documentation

**Files:**
- Modify: `README.md` (if needed)

**Step 1: Verify no remaining references to old code**

Search for any remaining imports of removed modules:

```bash
grep -r "DuckDBContext\|useDuckDB\|duckdb-wasm\|@anthropic-ai/sdk\|apiKey\|dangerouslyAllowBrowser" src/
```

Fix any found references.

**Step 2: Verify clean build**

```bash
npm run build
cd backend && poetry run python -c "from app.main import app; print('Backend OK')"
```

**Step 3: Final commit**

```bash
git add -A
git commit -m "chore: final cleanup after FastAPI + Agent SDK migration"
```
