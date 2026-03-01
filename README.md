# DuckDB Data Agent

> **Note:** This project is built with [Claude Code](https://claude.com/product/claude-code)(using Opus 4.6 and [superpowers](https://github.com/obra/superpowers)) by **more than 99%** and human-reviewed by author.

https://github.com/user-attachments/assets/eeb5e144-062c-444a-8232-679830b048de

Or you can see examples online: [example1](https://raw.githack.com/cyyeh/duckdb-data-agent/main/examples/example1.html), [example2](https://raw.githack.com/cyyeh/duckdb-data-agent/main/examples/example2.html), [example3](https://raw.githack.com/cyyeh/duckdb-data-agent/main/examples/example3.html)

---

An AI-powered data analysis agent with a built-in SQL playground. Upload data files (CSV, JSON, Parquet, Excel) and ask questions in plain English — the agent delegates to a specialized subagent for SQL queries and renders charts inline — or switch to the SQL editor for direct queries. Powered by [DuckDB](https://duckdb.org/) on a lightweight [FastAPI](https://fastapi.tiangolo.com/) backend with a React frontend. The app opens in Agent Mode by default so you can start analyzing data immediately.

Each browser tab gets its own isolated DuckDB session — uploaded data and query state are fully isolated between users and tabs. Sessions are persisted to disk so your tables survive idle timeouts; the session file is only deleted when you close the tab explicitly.

## Features

### General

- **Per-user DuckDB sessions** — Each browser tab gets its own isolated DuckDB instance, identified by a `X-Session-ID` header generated client-side; data and state are never shared between users or tabs; sessions are persisted to disk (`/tmp/duckdb-data-agent-{session_id}.duckdb`) so tables survive idle timeouts and reconnections; the session file is deleted only on explicit tab close
- **DuckDB SQL engine** — Fast, in-process analytical database on the backend
- **Multi-format file upload** — Drag-and-drop or click to import CSV, JSON, Parquet, and Excel (.xlsx) files (default limit: 500 MB, configurable via `MAX_TOTAL_SIZE_BYTES` env var) with automatic schema detection; Excel workbooks with multiple sheets create one table per sheet; duplicate filename detection prevents accidental overwrites; the upload UI appears when no tables are loaded, and files can also be added via the sidebar upload button
- **Sample dataset** — One-click load of the Titanic dataset to get started quickly
- **Table sidebar** — Collapsible panel to browse tables, inspect columns, and view types
- **Dark / light mode** — Toggle between dark and light themes with the sun/moon button in the header; respects your OS preference on first visit and remembers your choice across sessions
- **Internationalization (i18n)** — Switch between English and Traditional Chinese with the EN/中 toggle in the header; auto-detects your OS language on first visit and remembers your choice across sessions
- **Interactive clarification** — When your request is ambiguous, the agent asks a clarifying question with selectable options displayed inline in the chat; pick an option or type a free-text response to continue
- **Export conversation** — Click the Export button to download the full conversation as a single self-contained HTML file; the export preserves the current theme, collapsible thinking blocks, interactive Plotly charts (via CDN), and styled query result tables; interactive-only elements (edit/delete buttons, retry buttons) are stripped for a clean read-only view

### Agent Mode (default mode)

- **Natural language queries** — Ask questions about your data in plain English; the orchestrator delegates to specialized subagents that write and execute SQL for you
- **Subagent architecture** — An orchestrator agent delegates to a **sql-analyst** subagent for data queries, with a configurable model (via `SQL_SUBAGENT_MODEL` env var, defaulting to `haiku`); the orchestrator itself handles chart rendering via `render_chart` for coherent interleaved text-and-chart answers
- **Streaming responses** — Real-time token streaming powered by Claude via the [Anthropic Agent SDK](https://github.com/anthropics/anthropic-sdk-python); subagent internal reasoning is filtered from the main stream
- **Visible reasoning** — Collapsible thinking block shows the agent's intermediate steps and SQL queries
- **Inline results** — Query results rendered inline within the conversation
- **Chart generation** — Ask for a chart or visualization and the orchestrator generates it inline; supports bar, scatter, line, pie, histogram, box, and heatmap chart types with optional multi-series grouping, powered by Plotly; animated charts with frames, sliders, and play/pause controls are also supported
- **Edit & delete messages** — Hover over any user message to edit or delete it; editing re-sends the modified query with prior conversation as context, deleting rewinds the conversation to that point
- **Bifrost LLM gateway** — A [Bifrost](https://github.com/maximhq/bifrost) gateway service manages API keys centrally and routes LLM requests to multiple providers; sidecar containers never have access to real API keys (see [Security](#security))
- **Privacy-conscious** — Requires an Anthropic API key stored in a server-side `.env` file; your data and credentials are never sent anywhere besides the Anthropic API
- **Container isolation** — Run each agent session inside a [gVisor](https://gvisor.dev/)-sandboxed Docker container for code execution sandboxing and multi-tenant isolation; read-only rootfs, all capabilities dropped, no host filesystem or Docker socket access (see [Container Isolation](#container-isolation))
- **Langfuse observability** (optional) — Built-in [Langfuse](https://langfuse.com/) tracing for monitoring agent interactions

### Skills

- **Browse skills** — A "Skills" tab in the sidebar lists available skills with name and description; click a skill to open a detail modal with Preview and Source tabs; click "Use" to append a `/skill-name` slash command to the current chat input text
- **Invoke skills via slash command** — Type `/` anywhere in the chat input to open an autocomplete dropdown of available skills; the menu filters as you type and works at any cursor position, not just the beginning of the input
- **Multiple skills per message** — Combine multiple skills in a single message (e.g., `use this skill /analyze-data use this skill /my-other-skill What is the average revenue?`); all referenced skills are invoked before the agent processes your question
- **Enable/disable skills** — Toggle the eye icon on any skill to enable or disable it; disabled skills are hidden from the slash command menu and cannot be invoked
- **Delete skills** — Remove custom skills via the delete button in the sidebar; built-in skills (like `analyze-data`) cannot be deleted
- **Create skills from the UI** — Click the "+" button in the Skills tab to create a new skill with a name, description, and step-by-step instructions; skills are stored as `SKILL.md` files on disk
- **Agent-created skills** — The agent can create new skills during a conversation via the `create_skill` MCP tool; new skills appear in the sidebar automatically
- **Dynamic skill discovery** — Skills are stored at `skills/<name>/SKILL.md` and re-scanned per request; add or remove skills without restarting

### Editor Mode

- **SQL query editor** — Write and execute queries with Ctrl/Cmd+Enter
- **Interactive results** — Sortable columns, per-column filters, and global search across results
- **EXPLAIN support** — Markdown-rendered output for `EXPLAIN` and `EXPLAIN ANALYZE` queries

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Python](https://www.python.org/) 3.12+
- [Poetry](https://python-poetry.org/)
- [Docker](https://docs.docker.com/get-docker/)

### Installation

```bash
make install
```

### Configuration

Copy the example environment file and add your credentials:

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env` and set your Anthropic API key:

```
ANTHROPIC_API_KEY=sk-ant-...
ORCHESTRATOR_MODEL=claude-sonnet-4-6           # optional, defaults to sonnet
SQL_SUBAGENT_MODEL=haiku           # optional, model for SQL analyst subagent (default: haiku)
DEFAULT_TOOL_MODEL=                # optional, fallback model for SDK built-in tools (see below)
MAX_TOTAL_SIZE_BYTES=524288000      # optional, max upload size in bytes (default: 500 MB)
```

> `ANTHROPIC_API_KEY` and `ORCHESTRATOR_MODEL` are only needed for the AI agent. The SQL playground works without them, but both require the backend running.

#### Per-Subagent Model Routing

You can route each agent (orchestrator, SQL subagent) to a different LLM provider by using the `@suffix` syntax:

```
ORCHESTRATOR_MODEL=openai/gpt-4o@sonnet
SQL_SUBAGENT_MODEL=openai/gpt-4o-mini@haiku
```

The format is `real_model@sdk_alias`. The SDK alias (after `@`) is the model name the Claude Agent SDK sees; the real model (before `@`) is what the backend proxy rewrites it to before forwarding to Bifrost. This lets you use any provider Bifrost supports (OpenAI, Bedrock, etc.) while keeping the SDK configuration unchanged.

**How it works:**

1. The SDK sends requests using the alias (e.g. `sonnet`, `haiku`).
2. A lightweight reverse proxy on the backend (`/anthropic/*`) intercepts these requests.
3. The proxy rewrites the `model` field to the real provider model (e.g. `openai/gpt-4o`) and forwards the request to Bifrost.
4. Bifrost routes the request to the correct provider.

Without `@suffix`, model values are used as-is (direct Anthropic routing).

#### Default Tool Model

The Claude Agent SDK's built-in tools (e.g. WebFetch) internally use their own Anthropic models (e.g. `claude-haiku-4-5-20251001`). When routing all traffic through a non-Anthropic provider, these models are not in the rewrite map and will fail because they lack a provider prefix.

Set `DEFAULT_TOOL_MODEL` to catch any model not matched by the per-agent rewrites:

```
DEFAULT_TOOL_MODEL=openai/gpt-4o-mini
```

Any request whose model does not match a configured rewrite is rewritten to this value before forwarding to Bifrost. When empty (default), unmatched models pass through unchanged.

> **Warning:** The `@suffix` must NOT match the `ORCHESTRATOR_MODEL`'s Anthropic model name. For example, `ORCHESTRATOR_MODEL=haiku` with `SQL_SUBAGENT_MODEL=openai/gpt-4o-mini@haiku` will conflict because the proxy cannot distinguish orchestrator traffic from subagent traffic when both resolve to the same model name.

#### Bifrost LLM Gateway

Copy the example config and adjust provider keys as needed:

```bash
cp bifrost/config.example.json bifrost/config.json
```

The default config routes requests through Anthropic using `ANTHROPIC_API_KEY` from your `backend/.env`. To add other providers (OpenAI, Bedrock, etc.), edit `bifrost/config.json` — see [`bifrost/config.example.json`](bifrost/config.example.json) for multi-provider examples. You can also configure providers via Bifrost's Web UI at `http://localhost:8081` (or `$BIFROST_PORT`). Note that you still need to set api keys and model names in `backend/.env`.

#### Langfuse (optional)

To enable agent tracing with [Langfuse](https://langfuse.com/), add these to `backend/.env`:

```
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com   # optional, defaults to cloud
```

When configured, every agent conversation is traced (LLM turns, tool calls, SQL execution) and a **Langfuse Traces** button appears in the agent panel header linking to your dashboard. When not configured, tracing is disabled with zero overhead.

### Development

First-time setup — install dependencies, build the sidecar image, and create the Docker network:

```bash
make install
```

Start both the frontend and backend:

```bash
make dev
```

Open http://localhost:5173 to use the app. The Vite dev server proxies `/api` requests to the backend automatically.

## Production Build and Deployment

Docker Compose builds both images (app + sidecar) and runs the app with [container isolation](#container-isolation) enabled. The sidecar image is built but not started as a service — the app spawns sidecar containers on-demand via the Docker SDK.

**Prerequisites:** [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/) (included with Docker Desktop).

**Build all images:**

```bash
make compose-build
```

**Start the app:**

```bash
make compose-up
```

Open http://localhost:10000 to use the app.

**Stop the app:**

```bash
make compose-down
```

**Notes:**

- **Linux users:** Set `DOCKER_GID` to your host's docker group GID so the app container can access the Docker socket:
  ```bash
  DOCKER_GID=$(getent group docker | cut -d: -f3) make compose-up
  ```
  On macOS with Docker Desktop, the default (`0`) works out of the box.
- **Linux users (skills write permission):** `make compose-build` automatically passes your host UID (`APP_UID`) so the container user can write to the bind-mounted `skills/` directory. If you build manually without the Makefile, pass it explicitly:
  ```bash
  APP_UID=$(id -u) docker compose --profile sidecar build
  ```
  On macOS with Docker Desktop, this is not needed as Docker handles file permissions transparently.
- **Custom port:** Set `APP_PORT` to expose the app on a different host port (e.g., `APP_PORT=8080 make compose-up`).

## Security

### Bifrost LLM Gateway

When the agent runs, the backend spawns a sidecar container via the Docker SDK. A naive approach would pass `ANTHROPIC_API_KEY` directly into that container's environment — but any tool or shell command the agent executes could then read and exfiltrate the key.

Instead, a [Bifrost](https://github.com/maximhq/bifrost) LLM gateway service manages API keys centrally and routes requests to LLM providers:

```
Sidecar Container
  → ANTHROPIC_BASE_URL=http://bifrost:8080/anthropic
  → ANTHROPIC_API_KEY=placeholder
        ↓
Bifrost Gateway (/anthropic)
  → ignores client-sent key
  → injects the real provider API key
  → forwards request to provider (Anthropic, OpenAI, Bedrock, etc.)
```

**How it works:**

1. Bifrost runs as a Docker Compose service with real API keys stored in `bifrost/config.json` (referencing environment variables).
2. Sidecar containers receive a placeholder `ANTHROPIC_API_KEY` and point `ANTHROPIC_BASE_URL` to Bifrost's native `/anthropic` endpoint.
3. Bifrost injects the real provider API key when forwarding requests upstream. The Claude Agent SDK works unchanged since Bifrost speaks native Anthropic Messages API.
4. Additional providers (OpenAI, Bedrock, Vertex, etc.) can be added to `bifrost/config.json` or via Bifrost's Web UI. Use provider prefixes in model names (e.g., `openai/gpt-4o-mini`) to route subagent requests to different providers. See [`bifrost/config.example.json`](bifrost/config.example.json) for configuration examples.

The sidecar container only ever holds a placeholder string. Even if a tool call reads the environment, it cannot obtain any real API key.

### Container Isolation

The backend runs each Claude Code session inside a **gVisor-sandboxed Docker container** ("sidecar"). This provides code execution sandboxing, multi-tenant isolation, and a hardened boundary between the agent and the host system.

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
  │              ├──► Bifrost Gateway (:8080/anthropic)  (LLM routing)
  ├── /mcp/sse   ◄───────┘  (DuckDB MCP bridge)
  │
  └── DuckDB (per-user, disk-persisted)
```

The data flow for a chat message is:

1. Frontend sends a chat message to the FastAPI backend.
2. Backend spins up a gVisor container (or reuses an existing one for the session) via `ContainerManager`, configured to route LLM calls through the Bifrost gateway.
3. Backend sends the query to the sidecar's `POST /query` endpoint. The sidecar calls the Claude Agent SDK's `query()` function with `includePartialMessages: true` for token-level streaming, configured with the host's MCP SSE endpoint.
4. The agent talks to the Bifrost gateway (`/anthropic`) for LLM API access (using a placeholder key; Bifrost injects the real key).
5. The agent's `execute_sql` tool calls reach the host DuckDB via the **MCP SSE bridge** (`/mcp/sse?session_id=...`), which routes each connection to the correct per-user DuckDB instance through the existing `SessionManager`.
6. The sidecar streams SSE events back to the backend, which forwards them to the frontend.
7. On session end, the container is stopped and removed.

**Sidecar container:** The `sidecar/` directory contains a TypeScript HTTP server (`src/server.ts`) that uses the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) with `includePartialMessages: true` for true token-level streaming. The Docker image (`sidecar/Dockerfile`) bundles Node.js 20, Python 3.12, and the Agent SDK. Containers run with a read-only root filesystem, all Linux capabilities dropped, no Docker socket access, and a non-root user. The host `skills/` directory is bind-mounted read-only at `/app/.claude/skills/` (the project-level path) so the SDK's built-in Skill tool can discover and invoke them.

**MCP SSE bridge:** The backend exposes tools at `/mcp/sse` using the MCP protocol's SSE transport (`backend/app/mcp_sse.py`): `execute_sql` for DuckDB queries, `render_chart` for chart generation, `ask_user_question` for interactive clarification, and `create_skill` for agent-driven skill creation. Each SSE connection requires a `session_id` query parameter to route tool calls to the correct per-user DuckDB instance. This is how the containerized agent reaches DuckDB on the host without any direct database access inside the container.

**Prerequisites:**

- [Docker](https://docs.docker.com/get-docker/)
- [gVisor (runsc)](https://gvisor.dev/docs/user_guide/install/) (Optional) runtime installed and registered with Docker

> **Note:** gVisor requires **Linux** (kernel 4.14.77+, x86_64 or ARM64). It is not available on macOS or Windows. On non-Linux hosts (e.g., macOS with Docker Desktop), set `CONTAINER_RUNTIME=runc` to use Docker's default runtime instead. You still get container isolation (filesystem, process, network, capability drop, read-only rootfs) — only gVisor's syscall interception layer is absent. For production multi-tenant deployments, use a Linux host with gVisor for full sandboxing.

**Setup:**

1. Build the sidecar image and create the Docker network:

   ```bash
   docker compose build
   make sidecar-network
   ```

2. Install gVisor by following the [official guide](https://gvisor.dev/docs/user_guide/install/).

3. Start the app:

   ```bash
   make compose-up
   ```

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTAINER_IMAGE` | `duckdb-agent-sidecar:latest` | Sidecar Docker image |
| `CONTAINER_RUNTIME` | `runc` | Docker runtime (runc for non-gVisor, runsc for gVisor) |
| `CONTAINER_MEMORY_LIMIT` | `512m` | Memory limit per container |
| `CONTAINER_CPU_LIMIT` | `0.5` | CPU limit per container |
| `CONTAINER_MAX_LIFETIME_SECONDS` | `3600` | Max container lifetime |
| `CONTAINER_IDLE_TIMEOUT_SECONDS` | `300` | Idle timeout before container is stopped (5 min) |
| `CONTAINER_NETWORK` | `agent-sandbox` | Docker network name |
| `SKILLS_DIR` | `skills` | Path to skills directory (inside backend container) |
| `SKILLS_HOST_PATH` | `./skills` | Host path for skills volume mount (bind-mounted read-only at `/app/.claude/skills/` in sidecar containers) |
| `APP_UID` | `1000` | UID for the container user (set to `$(id -u)` on Linux so skills directory writes work; not needed on macOS) |

**Security properties:**

- The container has no host filesystem access except a read-only bind mount of the `skills/` directory
- gVisor intercepts all syscalls -- even arbitrary bash/python execution is sandboxed
- No real API keys inside the container (placeholder string only; real keys managed by Bifrost)
- Per-session isolation -- containers cannot see each other
- Resource limits (CPU, memory, lifetime) prevent denial-of-service against the host
- Internal networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) are blocked, preventing cloud metadata and internal service access

For full design details, see [`docs/plans/2026-02-22-containerized-runtime-design.md`](docs/plans/2026-02-22-containerized-runtime-design.md).

## E2E Testing

Browser-based end-to-end tests are driven by YAML scenario files using [Playwright](https://playwright.dev/). Define test scenarios declaratively — the runner handles browser automation, structural DOM assertions, and LLM-as-judge semantic verification.

**Install:**

```bash
make install-e2e
```

**Environment setup:** Scenarios using `verify_llm` (LLM-as-judge) require an Anthropic API key. Create `e2e/.env` with:

```
ANTHROPIC_API_KEY=your-key-here
```

**Run tests** (requires `make dev` running in another terminal):

```bash
make e2e-test            # headless (default)
make e2e-test-headed     # with visible browser
make e2e-test-ui         # interactive Playwright UI
```

**View HTML report:**

```bash
make e2e-report
```

**Configure target environment** via `BASE_URL` (defaults to `http://localhost:5173`):

```bash
BASE_URL=http://localhost:10000 make e2e-test
```

**Writing scenarios:** Add YAML files to `e2e/scenarios/`. Each file contains a list of scenarios with sequential steps:

```yaml
scenarios:
  - name: "Upload CSV and query"
    steps:
      - action: upload_file
        file: ./test-data/sales.csv
      - action: send_message
        input: "Show total sales by region"
      - action: wait_for_response
      - action: verify
        expected:
          contains: ["north", "south"]
          has_chart: true
      - action: verify_llm
        criteria: "Response shows sales by region with numeric values"
        pass_threshold: 0.7
```

**Available actions:** `upload_file`, `send_message`, `wait_for_response`, `click`, `navigate`, `verify` (structural DOM checks), `verify_llm` (LLM-as-judge with Anthropic API — requires `ANTHROPIC_API_KEY`).

**Structural verifiers:** `contains`, `not_contains`, `has_chart`, `has_table`, `table_row_count_min`, `element_exists`, `element_not_exists`, `css_property`.

## Project Structure

```
├── frontend/               # React frontend
│   ├── src/
│   │   ├── components/     #   UI components (editor, results, sidebar, chat, charts, skills, user-question)
│   │   ├── contexts/       #   React context providers (theme, language, agent, config, session)
│   │   ├── hooks/          #   Custom hooks (useTheme, useTranslation, useAgent, useConfig, useSessionId)
│   │   ├── agent/          #   Agent service (SSE event handling, session ID injection)
│   │   ├── services/       #   API clients (skillsService.ts)
│   │   ├── i18n/           #   Translation files (en.json, zh-TW.json)
│   │   ├── utils/          #   Utility functions (UUID generation, conversation export)
│   │   └── types.ts        #   Shared TypeScript interfaces
│   ├── index.html          #   HTML entry point
│   ├── package.json        #   npm config
│   └── vite.config.ts      #   Vite bundler config
├── backend/                # FastAPI backend
│   ├── Dockerfile          #   Production image: Python 3.12 + React frontend bundle
│   ├── app/
│   │   ├── main.py         #   App setup, CORS, and background session/container cleanup loop
│   │   ├── config.py       #   Environment variables (API key, model, upload limits, container settings)
│   │   ├── database.py     #   DuckDB connection and query execution
│   │   ├── session_manager.py  #   Per-user DuckDB session lifecycle (create, cleanup, disk persistence)
│   │   ├── agent.py        #   Agent loop, subagent definitions, & SSE streaming via container sidecar
│   │   ├── skills.py       #   Skill CRUD operations (read/write SKILL.md files)
│   │   ├── mcp_sse.py      #   MCP SSE endpoint: exposes DuckDB, chart, and create_skill tools over HTTP
│   │   ├── container_manager.py  #   Docker container lifecycle management for sidecar containers
│   │   ├── proxy.py        #   Reverse proxy for per-subagent model routing (@suffix rewriting)
│   │   ├── pending_questions.py  #   Interactive clarification (agent asks user for disambiguation)
│   │   ├── dependencies.py #   FastAPI dependency injection utilities
│   │   ├── tracing.py      #   Langfuse client wrapper & initialization
│   │   ├── data/           #   Sample datasets (titanic.csv)
│   │   └── routes/         #   API endpoints
│   │       ├── chat.py     #     Chat endpoint with SSE streaming
│   │       ├── query.py    #     SQL query execution
│   │       ├── tables.py   #     Table inspection (schema, columns, sample data)
│   │       ├── session.py  #     Session creation and deletion
│   │       ├── skills.py   #     Skills CRUD REST API (/api/skills)
│   │       ├── config.py   #     Runtime configuration
│   │       └── langfuse_status.py  #   Langfuse tracing status and link
│   └── tests/              #   Unit tests (pytest)
│       ├── test_skills.py
│       ├── test_skills_routes.py
│       ├── test_container_manager.py
│       ├── test_mcp_sse.py
│       ├── test_proxy.py
│       ├── test_session_manager.py
│       └── ...             #   14 test modules total
├── skills/                 # Skill definitions (SKILL.md files, volume-mounted into sidecar containers)
│   ├── analyze-data/       #   Built-in data analysis workflow skill
│   └── <name>/             #   Custom skills (each with a SKILL.md file)
├── sidecar/                # Containerized agent sidecar
│   ├── src/
│   │   ├── server.ts       #   TypeScript HTTP server using Claude Agent SDK with token-level streaming
│   │   └── types.ts        #   Request/response type definitions
│   ├── Dockerfile          #   Sidecar image: Node.js 20 + Python 3.12
│   ├── package.json        #   npm config
│   └── setup-network.sh    #   Docker network setup script
├── e2e/                    # Playwright E2E tests
│   ├── scenarios/          #   YAML test scenario files
│   ├── test-data/          #   Test fixture files (CSV, etc.)
│   ├── tests/              #   Dynamic test generator (scenario-runner.spec.ts)
│   ├── lib/                #   YAML loader, actions, verifiers, LLM judge
│   └── playwright.config.ts
├── bifrost/                # Bifrost LLM gateway configuration
│   └── config.example.json #   Example provider keys and routing config (copy to config.json)
├── examples/               # Exported conversation examples (self-contained HTML)
├── docs/plans/             # Design and implementation plan documents
├── utils/                  # Standalone utility scripts
├── .github/workflows/      # GitHub Actions CI/CD (code review, CI)
├── docker-compose.yml      # Compose orchestration (bifrost + app + sidecar build)
└── Makefile                # Dev commands (install, dev, compose-build/up/down, e2e-test, clean)
```

## Tech Stack

**Frontend**
- [React](https://react.dev/) 18 + [TypeScript](https://www.typescriptlang.org/)
- [Vite](https://vite.dev/)
- [Plotly](https://plotly.com/javascript/) via [react-plotly.js](https://github.com/plotly/react-plotly.js) (chart rendering)

**Backend**
- [FastAPI](https://fastapi.tiangolo.com/) + [Uvicorn](https://www.uvicorn.org/)
- [DuckDB](https://duckdb.org/) (Python)
- [Anthropic Agent SDK](https://github.com/anthropics/anthropic-sdk-python)
- [MCP](https://modelcontextprotocol.io/) SSE transport (DuckDB tool bridge for containers)
- Subagent architecture via Claude Agent SDK `AgentDefinition` API (sql-analyst)
- [Docker SDK for Python](https://docker-py.readthedocs.io/) + [gVisor](https://gvisor.dev/) (container isolation)
- [Langfuse](https://langfuse.com/) (optional, for observability)

**Sidecar**
- [Node.js](https://nodejs.org/) 20 + [TypeScript](https://www.typescriptlang.org/)
- [Express](https://expressjs.com/) HTTP server
- [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) (`@anthropic-ai/claude-agent-sdk`) with token-level streaming

**LLM Gateway**
- [Bifrost](https://github.com/maximhq/bifrost) — centralized API key management and multi-provider LLM routing (Anthropic, OpenAI, Bedrock, etc.)

## License

[MIT](LICENSE.txt)
