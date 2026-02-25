# Remove Subprocess Mode — Design

**Date:** 2026-02-25
**Status:** Approved

## Goal

Remove the "agent in subprocess" mode entirely. The sidecar (containerized Docker) mode becomes the only way to run the agent. Also remove Render deployment support and update the README.

## Decisions

- Docker is always required (no non-Docker fallback)
- `render.yaml` and root `Dockerfile` are deleted
- `docker-compose.yml` is the single deployment method
- Dev workflow is hybrid: local backend + frontend, sidecar container for agent execution
- `CONTAINER_ENABLED` flag is removed (always on)

## Files to Delete

| File | Reason |
|------|--------|
| `backend/app/tools.py` | MCP tool definitions only used by subprocess mode |
| `Dockerfile` (root) | Standalone image for subprocess mode |
| `render.yaml` | Render deployment (no nested Docker support) |

## Backend Changes

### `backend/app/agent.py`

- Delete the entire subprocess code path (~360 lines): `ClaudeSDKClient` setup, streaming loop, Langfuse tracing, monkey-patch block
- Remove imports: `ClaudeSDKClient`, `ClaudeAgentOptions`, `StreamEvent`, `AssistantMessage`, `UserMessage`, `ResultMessage`, `ToolUseBlock`, `ToolResultBlock`, `MessageParseError`, `create_duckdb_server`, monkey-patch module import
- Rename `_stream_chat_container()` to `stream_chat()` (or inline it)
- Remove `CONTAINER_ENABLED` check and Docker fallback logic
- Keep: `build_system_prompt()`, `build_subagent_definitions()`, `_extract_chart_spec()`, `_build_message_with_history()`, all container streaming logic

### `backend/app/config.py`

- Remove `CONTAINER_ENABLED` (always true now)
- Keep all other `CONTAINER_*` settings

### `backend/app/main.py`

- Remove conditional `if CONTAINER_ENABLED:` checks
- Always import and use `container_manager`
- Container cleanup always runs in background loop and shutdown

### `backend/app/container_manager.py`

- No changes (already handles Docker unavailability gracefully)

## Docker & Dev Workflow Changes

### `docker-compose.yml`

- Remove `CONTAINER_ENABLED: "true"` from environment block (no longer a toggle)

### `Makefile`

- Update `make dev` for hybrid mode (local backend + frontend, requires sidecar)
- Add `make sidecar-build` target (build sidecar image)
- Add `make sidecar-up` target (start sidecar for local dev)
- Dev workflow: `make sidecar-build` + `make sidecar-network` (one-time), then `make dev`

### Dev `.env`

- Needs `PROXY_BASE_URL=http://host.docker.internal:8000` so sidecar can reach local backend

## README Updates

- Remove "Deploy to Render" button/badge and section
- Remove standalone Docker build section
- Remove "(optional)" from container isolation everywhere
- Update Prerequisites to require Docker
- Update Development section for hybrid dev workflow
- Update Production section to show docker-compose only
- Update Security section: remove subprocess fallback language, remove `CONTAINER_ENABLED` from env var table
- Update Project Structure: remove deleted files, remove "(optional)" from sidecar
- Update Tech Stack: sidecar is required, not optional
- Update Features: remove fallback language

## What Does NOT Change

- Frontend (completely mode-agnostic, processes identical SSE events)
- `backend/app/container_manager.py` (no changes needed)
- `backend/app/proxy.py` (credential proxy used by both modes)
- `backend/app/mcp_sse.py` (MCP SSE bridge used by container mode)
- `sidecar/` directory (the sidecar itself is unchanged)
- All other backend routes and utilities
