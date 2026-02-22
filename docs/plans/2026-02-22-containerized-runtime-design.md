# Containerized Claude Code Runtime Design

**Date:** 2026-02-22
**Status:** Approved

## Problem

Claude Code runs as a subprocess on the host machine via the Anthropic Agent SDK. While the credential proxy prevents API key extraction, the subprocess still has access to the host's filesystem, processes, and network. A malicious prompt could:

- Read or modify files on the host
- Access other users' processes or environment variables
- Scan internal networks or cloud metadata endpoints
- Consume unbounded host resources (CPU, memory)

Multi-tenant deployments need stronger isolation between user sessions and between the agent subprocess and the host.

## Solution

Run each Claude Code session inside a dedicated **gVisor-sandboxed Docker container** (the "sidecar"). The sidecar contains Node.js, Python 3, and the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) behind a thin TypeScript HTTP server. The SDK spawns the Claude CLI internally and provides true token-level streaming via `includePartialMessages`. The host backend manages container lifecycle via Docker SDK for Python and communicates with the sidecar over HTTP.

DuckDB stays on the host — the sidecar accesses it via MCP over the host network. No files, secrets, or host mounts enter the container.

A feature flag (`CONTAINER_ENABLED`) allows graceful fallback to the existing subprocess model for PaaS environments (Render, Railway) that don't support nested Docker.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Host Machine                                               │
│                                                             │
│  ┌──────────────────────────────────────────────────┐       │
│  │  FastAPI Backend                                 │       │
│  │                                                  │       │
│  │  ┌────────────┐  ┌──────────┐  ┌──────────────┐ │       │
│  │  │ Chat Route │  │ Cred     │  │ Container    │ │       │
│  │  │ (SSE)      │  │ Proxy    │  │ Manager      │ │       │
│  │  └─────┬──────┘  └────▲─────┘  └──────┬───────┘ │       │
│  │        │              │               │          │       │
│  │  ┌─────┴──────┐       │         ┌─────┴───────┐ │       │
│  │  │ Session    │       │         │ Docker SDK  │ │       │
│  │  │ Manager    │       │         │ (python)    │ │       │
│  │  └────────────┘       │         └─────┬───────┘ │       │
│  │                       │               │          │       │
│  │  ┌────────────┐       │               │          │       │
│  │  │ DuckDB     │       │               │          │       │
│  │  │ (per-user) │       │               │          │       │
│  │  └────────────┘       │               │          │       │
│  └───────────────────────┼───────────────┼──────────┘       │
│                          │               │                  │
│         ┌────────────────┼───────────────┼────────────────┐ │
│         │  gVisor Sandbox│(per session)  │                │ │
│         │                │               │                │ │
│         │  ┌─────────────┴──────────┐    │                │ │
│         │  │  Agent Sidecar         │    │                │ │
│         │  │                        │    │                │ │
│         │  │  Node.js + Python 3    │    │                │ │
│         │  │  + Claude Agent SDK    │    │                │ │
│         │  │  + TypeScript HTTP API │    │                │ │
│         │  │                        │    │                │ │
│         │  │  POST /query → stream  │    │                │ │
│         │  │  GET  /health          │    │                │ │
│         │  │  POST /stop            │    │                │ │
│         │  └────────────────────────┘    │                │ │
│         │                                │                │ │
│         │  Network: host proxy + public  │                │ │
│         │  No filesystem mounts          │                │ │
│         │  No secrets inside             │                │ │
│         └────────────────────────────────┘                │ │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Data flow:**
1. Frontend sends chat message to FastAPI backend
2. Backend creates a short-lived UUID token via credential proxy
3. `ContainerManager` spins up a gVisor container (or reuses existing one for the session)
4. Backend sends query to sidecar via `POST /query` with UUID token and proxy URL
5. Sidecar calls the Claude Agent SDK's `query()` function with `includePartialMessages: true`, which spawns Claude CLI internally; the CLI talks to host credential proxy for API access
6. Claude CLI's MCP tool calls go to host DuckDB via host network
7. Sidecar forwards raw SDK messages (including token-level streaming deltas) as SSE events back to backend
8. Backend forwards SSE events to frontend (unchanged format)
9. On session end, container is stopped and removed; UUID token is revoked

## Components

### New files

| File | Purpose |
|---|---|
| `sidecar/Dockerfile` | Sidecar container image: Node.js 20 + Python 3.12 + Claude CLI |
| `sidecar/src/server.ts` | TypeScript HTTP server using Claude Agent SDK `query()` with token-level streaming |
| `sidecar/src/types.ts` | Request/response type definitions |
| `sidecar/package.json` | Dependencies (`@anthropic-ai/claude-agent-sdk`, express, tsx) |
| `sidecar/tsconfig.json` | TypeScript config |
| `backend/app/container_manager.py` | Docker SDK container lifecycle management |

### Modified files

| File | Change |
|---|---|
| `backend/app/agent.py` | Add container path: when `CONTAINER_ENABLED`, call `ContainerManager` instead of spawning subprocess directly; handle SDK `stream_event` messages for token-level streaming |
| `backend/app/config.py` | Add container-related env vars |
| `backend/app/main.py` | Initialize `ContainerManager`, register shutdown cleanup |
| `backend/pyproject.toml` | Add `docker` Python package dependency |

## Key Details

### Sidecar container image

Base image combines Node.js 20 and Python 3.12. Contains:
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) — TypeScript SDK that spawns Claude CLI internally
- Claude CLI (`@anthropic-ai/claude-code`) — installed globally, required by the SDK
- TypeScript HTTP server compiled at build time
- Python 3.12 runtime (for Claude Code to execute Python scripts)
- No application secrets, no data files, no host mounts

```dockerfile
FROM python:3.12-slim AS build
# Install Node.js 20
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs
# Build the sidecar server (needs devDependencies for tsc)
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs
# Install Claude CLI globally (required by the Agent SDK)
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /app
# SDK dependency (@anthropic-ai/claude-agent-sdk) is in package.json
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
RUN useradd --create-home --shell /bin/bash appuser
USER appuser
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

### Sidecar HTTP API

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Readiness probe. Returns 200 when Claude CLI is ready. |
| `/query` | POST | Accepts `{message, session_id, system_prompt, model, mcp_server_url, env}`. Uses SDK `query()` with `includePartialMessages: true`. Forwards raw SDK messages as SSE `data:` lines (JSON). Message types: `stream_event` (token-level deltas), `assistant`, `user`, `result`, `system`. |
| `/stop` | POST | Gracefully stops the current query/session. |

Environment variables passed per-request via the `env` field in the POST body (merged with container process env):
- `ANTHROPIC_API_KEY` — short-lived UUID token
- `ANTHROPIC_BASE_URL` — `http://host.docker.internal:10000/anthropic`

The MCP server URL is passed in the `mcp_server_url` field of the POST body (not as an env var), and the SDK configures it as an SSE-type MCP server.

### Container manager

```python
class ContainerManager:
    """Manages per-session gVisor-sandboxed sidecar containers."""

    async def create(self, session_id: str, env: dict) -> ContainerInfo
    async def health_check(self, session_id: str) -> bool
    async def query(self, session_id: str, message: str, ...) -> AsyncIterator[SSEEvent]
    async def stop(self, session_id: str) -> None
    async def cleanup_expired(self) -> None
    async def shutdown_all(self) -> None
```

Container creation parameters:
- Image: `duckdb-agent-sidecar:latest`
- Runtime: `runsc` (gVisor)
- Read-only root filesystem with tmpfs `/tmp` (50MB)
- All Linux capabilities dropped (`--cap-drop=ALL`)
- No new privileges (`--security-opt=no-new-privileges`)
- Non-root user
- No volume mounts, no Docker socket access
- Auto-remove on stop
- Resource limits and max lifetime from env vars

### Networking

Docker network `agent-sandbox` (bridge mode):
- Sidecar → `host.docker.internal` (credential proxy + MCP server): **allowed**
- Sidecar → public internet (HTTP/HTTPS): **allowed**
- Sidecar → internal networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`): **blocked** (except host proxy address)
- Sidecar → other sidecar containers: **blocked**

Internal network blocking prevents cloud metadata endpoint access and internal service scanning.

### Configuration

New environment variables (in `config.py`):

```
CONTAINER_ENABLED=false             # Feature flag (default off)
CONTAINER_IMAGE=duckdb-agent-sidecar:latest
CONTAINER_RUNTIME=runsc
CONTAINER_MEMORY_LIMIT=256m
CONTAINER_CPU_LIMIT=0.5
CONTAINER_MAX_LIFETIME_SECONDS=600
CONTAINER_NETWORK=agent-sandbox
```

### Error handling

- **Docker unavailable / gVisor missing:** Fall back to subprocess model with warning log
- **Container crash mid-query:** Return error SSE event, revoke token, do not auto-restart
- **OOM kill:** Container auto-removed, error event sent to frontend
- **Max lifetime exceeded:** `cleanup_expired()` forcefully removes container, sends timeout error
- **Backend shutdown:** `shutdown_all()` iterates and removes all active containers

### Deployment compatibility

| Environment | Container support | Fallback |
|---|---|---|
| Self-hosted / bare metal | Full (Docker + gVisor) | N/A |
| Cloud VMs (EC2, GCP, Azure) | Full (install Docker + gVisor) | N/A |
| Kubernetes | Full (gVisor as RuntimeClass) | N/A |
| Render / Railway / Heroku | No | `CONTAINER_ENABLED=false`, uses subprocess model |
| Fly.io | Partial (Docker possible, gVisor unlikely) | `CONTAINER_ENABLED=false` |

Both paths produce identical SSE output — no frontend changes required.

## Security Properties

- Subprocess never accesses host filesystem, processes, or environment
- gVisor intercepts all syscalls — even if Claude Code runs arbitrary bash/python, it's sandboxed
- No real API keys inside the container (UUID token only, useless outside host proxy)
- Per-session isolation — containers cannot see each other
- Resource limits prevent denial-of-service against the host
- Internal network blocked — no cloud metadata or internal service access
- Public internet allowed for web fetching, but egress is limited to HTTP/HTTPS
- Feature flag allows safe fallback on unsupported platforms

## Testing

**Unit tests:**
- `ContainerManager` with mocked Docker SDK — lifecycle, cleanup, error cases
- Config parsing with defaults

**Integration tests (requires Docker + gVisor):**
- Spin up real sidecar, health check, query, verify SSE response, tear down
- Verify container timeout/cleanup
- Verify subprocess fallback when `CONTAINER_ENABLED=false`

**Manual verification:**
- End-to-end agent chat with containerized runtime
- `docker ps` shows sidecar with `runsc` runtime
- Container removed after session ends

## Out of Scope

- Kubernetes deployment manifests (separate follow-up)
- Container image CI/CD pipeline
- Warm pool / pre-warming optimization
- Container metrics/monitoring dashboard
- Per-user rate limiting at container level
