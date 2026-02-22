# DuckDB Data Agent

> **Note:** This project is built with [Claude Code](https://claude.com/product/claude-code)(using Opus 4.6 and [superpowers](https://github.com/obra/superpowers)) by more than 95% and human-reviewed by author.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

An AI-powered data analysis agent with a built-in SQL playground. Upload data files (CSV, JSON, Parquet, Excel) and ask questions in plain English, or switch to the SQL editor for direct queries — powered by [DuckDB](https://duckdb.org/) on a lightweight [FastAPI](https://fastapi.tiangolo.com/) backend with a React frontend. The app opens in Agent Mode by default so you can start analyzing data immediately.

Each browser tab gets its own isolated, in-memory DuckDB session — uploaded data and query state are fully isolated between users and tabs, with idle sessions automatically cleaned up after 5 minutes of inactivity.

## Features

### General

- **Per-user DuckDB sessions** — Each browser tab gets its own isolated in-memory DuckDB instance, identified by a `X-Session-ID` header generated client-side; data and state are never shared between users or tabs; idle sessions are automatically cleaned up after 5 minutes
- **DuckDB SQL engine** — Fast, in-process analytical database on the backend
- **Multi-format file upload** — Drag-and-drop or click to import CSV, JSON, Parquet, and Excel (.xlsx) files (default limit: 500 MB, configurable via `MAX_TOTAL_SIZE_BYTES` env var) with automatic schema detection; Excel workbooks with multiple sheets create one table per sheet; duplicate filename detection prevents accidental overwrites; the upload UI appears when no tables are loaded, and files can also be added via the sidebar upload button
- **Sample dataset** — One-click load of the Titanic dataset to get started quickly
- **Table sidebar** — Collapsible panel to browse tables, inspect columns, and view types
- **Dark / light mode** — Toggle between dark and light themes with the sun/moon button in the header; respects your OS preference on first visit and remembers your choice across sessions
- **Internationalization (i18n)** — Switch between English and Traditional Chinese with the EN/中 toggle in the header; auto-detects your OS language on first visit and remembers your choice across sessions

### Agent Mode (default mode)

- **Natural language queries** — Ask questions about your data in plain English; the agent writes and executes SQL for you
- **Streaming responses** — Real-time token streaming powered by Claude via the [Anthropic Agent SDK](https://github.com/anthropics/anthropic-sdk-python)
- **Visible reasoning** — Collapsible thinking block shows the agent's intermediate steps and SQL queries
- **Inline results** — Query results rendered inline within the conversation
- **Edit & delete messages** — Hover over any user message to edit or delete it; editing re-sends the modified query with prior conversation as context, deleting rewinds the conversation to that point
- **Credential proxy** — The backend runs a built-in Anthropic API reverse proxy; each agent session receives a short-lived UUID token instead of the real API key, so the Claude Code subprocess never has access to `ANTHROPIC_API_KEY`; tokens are revoked immediately when the session ends (see [Security](#security))
- **Privacy-conscious** — Requires an Anthropic API key stored in a server-side `.env` file; your data and credentials are never sent anywhere besides the Anthropic API
- **Langfuse observability** (optional) — Built-in [Langfuse](https://langfuse.com/) tracing for monitoring agent interactions, with a one-click dashboard link in the UI

### Editor Mode

- **SQL query editor** — Write and execute queries with Ctrl/Cmd+Enter
- **Interactive results** — Sortable columns, per-column filters, and global search across results
- **EXPLAIN support** — Markdown-rendered output for `EXPLAIN` and `EXPLAIN ANALYZE` queries

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Python](https://www.python.org/) 3.12+
- [Poetry](https://python-poetry.org/)

### Installation

```bash
make install
```

To also set up the sidecar for [container isolation](#container-isolation-optional) (requires Docker):

```bash
make install-all
```

### Configuration

Copy the example environment file and add your credentials:

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env` and set your Anthropic API key:

```
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=sonnet              # optional, defaults to sonnet
MAX_TOTAL_SIZE_BYTES=524288000      # optional, max upload size in bytes (default: 500 MB)
```

> `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` are only needed for the AI agent. The SQL playground works without them, but both require the backend running.

#### Langfuse (optional)

To enable agent tracing with [Langfuse](https://langfuse.com/), add these to `backend/.env`:

```
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com   # optional, defaults to cloud
```

When configured, every agent conversation is traced (LLM turns, tool calls, SQL execution) and a **Langfuse Traces** button appears in the agent panel header linking to your dashboard. When not configured, tracing is disabled with zero overhead.

### Development

Start both the frontend and backend:

```bash
make dev
```

To run with [container isolation](#container-isolation-optional) enabled (requires `make install-all`):

```bash
make dev-all
```

Open http://localhost:5173 to use the app. The Vite dev server proxies `/api` requests to the backend automatically.

## Production Build and Deployment

The project ships as a single Docker image that bundles the React frontend and FastAPI backend. A multi-stage `Dockerfile` builds the frontend, then copies the output into the backend's static directory.

### Build and run locally

```bash
docker build -t duckdb-data-agent .

docker run -p 10000:10000 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  duckdb-data-agent
```

Add `-e LANGFUSE_PUBLIC_KEY=pk-lf-... -e LANGFUSE_SECRET_KEY=sk-lf-...` to either command to enable Langfuse tracing.

Open http://localhost:10000 to use the app.

### Deploy to Render

A `render.yaml` is included for one-click deployment on [Render](https://render.com/):

1. Push this repo to GitHub.
2. In Render, create a new **Blueprint** and connect the repo.
3. Set `ANTHROPIC_API_KEY` in the Render dashboard. Optionally set `ANTHROPIC_MODEL` to override the default model (`sonnet`). To enable Langfuse tracing, also set `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`.

Render will build the Docker image and deploy it automatically on every push to `main`.

> **Note:** Render does not support nested Docker or gVisor, so the [Container Isolation](#container-isolation-optional) feature is **not available** on Render. The agent will use the default subprocess model (`CONTAINER_ENABLED=false`). Container isolation requires self-hosted infrastructure or cloud VMs where Docker and gVisor can be installed.

## Security

### Credential Proxy

When the agent runs, the backend spawns a Claude Code subprocess via the Anthropic Agent SDK. A naive approach would pass `ANTHROPIC_API_KEY` directly into that subprocess's environment — but any tool or shell command the agent executes could then read and exfiltrate the key.

Instead, the backend runs a built-in reverse proxy at `/anthropic` that sits between Claude Code and `api.anthropic.com`:

```
Claude Code subprocess
  → ANTHROPIC_BASE_URL=http://127.0.0.1:{PORT}/anthropic
  → ANTHROPIC_API_KEY=<short-lived UUID token>
        ↓
FastAPI proxy (/anthropic/{path})
  → validates UUID token
  → swaps it for the real ANTHROPIC_API_KEY
  → forwards request to api.anthropic.com
```

**How it works:**

1. Before each agent session, the backend mints a random UUID token with a 10-minute TTL.
2. The token is injected into the subprocess environment as `ANTHROPIC_API_KEY`; the real key is never exposed.
3. The proxy validates every inbound request against the token store and substitutes the real key before forwarding upstream.
4. When the session ends, the token is explicitly revoked in a `finally` block, regardless of success or error.
5. A background task runs every 60 seconds to sweep any tokens that outlived their TTL.

The subprocess only ever holds a single-session UUID. Even if a tool call reads the environment, all it gets is a temporary token scoped to that conversation.

### Container Isolation (Optional)

For additional defense in depth, the backend can run each Claude Code session inside a **gVisor-sandboxed Docker container** ("sidecar") instead of a bare subprocess. This provides code execution sandboxing, multi-tenant isolation, and a hardened boundary between the agent and the host system.

**Architecture:**

```
Browser
  │
  ▼
FastAPI Backend (host)
  ├── Chat route ──► ContainerManager ──► Docker SDK
  │                       │
  │                       ▼
  │               ┌──────────────────────┐
  │               │  gVisor Sandbox      │
  │               │                      │
  │               │  Sidecar Container   │
  │               │  (Node.js + Claude)  │
  │               │                      │
  │               │  POST /query → SSE   │
  │               └──────┬───────────────┘
  │                      │
  ├── /anthropic ◄───────┘  (credential proxy)
  ├── /mcp/sse   ◄───────┘  (DuckDB MCP bridge)
  │
  └── DuckDB (per-user, in-memory)
```

When `CONTAINER_ENABLED=true`, the data flow for a chat message is:

1. Frontend sends a chat message to the FastAPI backend.
2. Backend mints a short-lived UUID token via the credential proxy and spins up a gVisor container (or reuses an existing one for the session) via `ContainerManager`.
3. Backend sends the query to the sidecar's `POST /query` endpoint. The sidecar calls the Claude Agent SDK's `query()` function with `includePartialMessages: true` for token-level streaming, configured with the host's MCP SSE endpoint.
4. Claude CLI talks to the host credential proxy (`/anthropic`) for Anthropic API access (using the UUID token, never the real key).
5. Claude CLI's `execute_sql` tool calls reach the host DuckDB via the **MCP SSE bridge** (`/mcp/sse?session_id=...`), which routes each connection to the correct per-user DuckDB instance through the existing `SessionManager`.
6. The sidecar streams SSE events back to the backend, which forwards them to the frontend in the same format as the subprocess path.
7. On session end, the container is stopped and removed; the UUID token is revoked.

When `CONTAINER_ENABLED=false` (default), the existing in-process subprocess model is used with no container overhead.

**Sidecar container:** The `sidecar/` directory contains a TypeScript HTTP server (`src/server.ts`) that uses the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) with `includePartialMessages: true` for true token-level streaming. The Docker image (`sidecar/Dockerfile`) bundles Node.js 20, Python 3.12, the Agent SDK, and the `@anthropic-ai/claude-code` CLI (required by the SDK internally). Containers run with a read-only root filesystem, all Linux capabilities dropped, no volume mounts, no Docker socket access, and a non-root user.

**MCP SSE bridge:** The backend exposes the DuckDB `execute_sql` tool at `/mcp/sse` using the MCP protocol's SSE transport (`backend/app/mcp_sse.py`). Each SSE connection requires a `session_id` query parameter to route tool calls to the correct per-user DuckDB instance. This is how the containerized Claude CLI reaches DuckDB on the host without any direct database access inside the container.

**Prerequisites:**

- [Docker](https://docs.docker.com/get-docker/)
- [gVisor (runsc)](https://gvisor.dev/docs/user_guide/install/) (Optional) runtime installed and registered with Docker

> **Note:** gVisor requires **Linux** (kernel 4.14.77+, x86_64 or ARM64). It is not available on macOS or Windows. On non-Linux hosts (e.g., macOS with Docker Desktop), set `CONTAINER_RUNTIME=runc` to use Docker's default runtime instead. You still get container isolation (filesystem, process, network, capability drop, read-only rootfs) — only gVisor's syscall interception layer is absent. For production multi-tenant deployments, use a Linux host with gVisor for full sandboxing.

**Setup:**

1. Build the sidecar image and create the Docker network:

   ```bash
   make sidecar-setup
   ```

   Or run the steps individually: `make sidecar-build` and `make sidecar-network`.

2. Install gVisor by following the [official guide](https://gvisor.dev/docs/user_guide/install/).

3. Set `PROXY_BASE_URL` to an address reachable from containers (not `127.0.0.1`):

   ```
   PROXY_BASE_URL=http://host.docker.internal:8000
   ```

4. Start development with container isolation enabled:

   ```bash
   make dev-container
   ```

   Or enable manually by setting `CONTAINER_ENABLED=true` in your environment.

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTAINER_ENABLED` | `false` | Enable containerized runtime |
| `CONTAINER_IMAGE` | `duckdb-agent-sidecar:latest` | Sidecar Docker image |
| `CONTAINER_RUNTIME` | `runc` | Docker runtime (runc for non-gVisor, runsc for gVisor) |
| `CONTAINER_MEMORY_LIMIT` | `256m` | Memory limit per container |
| `CONTAINER_CPU_LIMIT` | `0.5` | CPU limit per container |
| `CONTAINER_MAX_LIFETIME_SECONDS` | `600` | Max container lifetime |
| `CONTAINER_NETWORK` | `agent-sandbox` | Docker network name |

**Security properties:**

- The subprocess never accesses the host filesystem, processes, or environment
- gVisor intercepts all syscalls -- even arbitrary bash/python execution is sandboxed
- No real API keys inside the container (UUID token only, useless outside the host proxy)
- Per-session isolation -- containers cannot see each other
- Resource limits (CPU, memory, lifetime) prevent denial-of-service against the host
- Internal networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) are blocked, preventing cloud metadata and internal service access

**Deployment note:** The `CONTAINER_ENABLED` feature flag defaults to `false`, allowing the backend to fall back to the subprocess model on PaaS platforms (Render, Railway) that do not support nested Docker. Both paths produce identical SSE output -- no frontend changes are required.

For full design details, see [`docs/plans/2026-02-22-containerized-runtime-design.md`](docs/plans/2026-02-22-containerized-runtime-design.md).

## Project Structure

```
├── frontend/               # React frontend
│   ├── src/
│   │   ├── components/     #   UI components (editor, results, sidebar, chat)
│   │   ├── contexts/       #   React context providers (theme, language, agent, config, session)
│   │   ├── hooks/          #   Custom hooks (useTheme, useTranslation, useAgent, useConfig)
│   │   ├── agent/          #   Agent service (SSE event handling, session ID injection)
│   │   ├── i18n/           #   Translation files (en.json, zh-TW.json)
│   │   └── types.ts        #   Shared TypeScript interfaces
│   ├── index.html          #   HTML entry point
│   ├── package.json        #   npm config
│   └── vite.config.ts      #   Vite bundler config
├── backend/                # FastAPI backend
│   └── app/
│       ├── main.py         #   App setup, CORS, and background session/container cleanup loop
│       ├── config.py       #   Environment variables (API key, model, upload limits, container settings)
│       ├── database.py     #   DuckDB connection, query execution, and per-user SessionManager
│       ├── agent.py        #   Agent loop & SSE streaming (subprocess + container paths)
│       ├── proxy.py        #   Credential proxy: token store + /anthropic reverse proxy
│       ├── mcp_sse.py      #   MCP SSE endpoint: exposes DuckDB tools over HTTP for containers
│       ├── container_manager.py  #   Docker container lifecycle management for sidecar containers
│       ├── tracing.py      #   Langfuse client wrapper & initialization
│       ├── tools.py        #   Agent SDK tool definitions (execute_sql)
│       ├── data/           #   Sample datasets (titanic.csv)
│       └── routes/         #   API endpoints (tables, query, chat, config, langfuse status, heartbeat)
├── sidecar/                # Containerized agent sidecar
│   ├── src/
│   │   ├── server.ts       #   TypeScript HTTP server using Claude Agent SDK with token-level streaming
│   │   └── types.ts        #   Request/response type definitions
│   ├── Dockerfile          #   Sidecar image: Node.js 20 + Python 3.12 + Claude CLI
│   └── setup-network.sh    #   Docker network setup script
├── Dockerfile              # Multi-stage production build
├── render.yaml             # Render deployment config
└── Makefile                # Dev commands (install, dev, dev-container, sidecar-setup, clean)
```

## Tech Stack

**Frontend**
- [React](https://react.dev/) 18 + [TypeScript](https://www.typescriptlang.org/)
- [Vite](https://vite.dev/)

**Backend**
- [FastAPI](https://fastapi.tiangolo.com/) + [Uvicorn](https://www.uvicorn.org/)
- [DuckDB](https://duckdb.org/) (Python)
- [Anthropic Agent SDK](https://github.com/anthropics/anthropic-sdk-python)
- [MCP](https://modelcontextprotocol.io/) SSE transport (DuckDB tool bridge for containers)
- [Docker SDK for Python](https://docker-py.readthedocs.io/) + [gVisor](https://gvisor.dev/) (optional, for container isolation)
- [Langfuse](https://langfuse.com/) (optional, for observability)

**Sidecar** (optional, for container isolation)
- [Node.js](https://nodejs.org/) 20 + [TypeScript](https://www.typescriptlang.org/)
- [Express](https://expressjs.com/) HTTP server
- [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) (`@anthropic-ai/claude-agent-sdk`) with token-level streaming
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) (`@anthropic-ai/claude-code`) — required by the SDK internally

## License

[MIT](LICENSE.txt)
