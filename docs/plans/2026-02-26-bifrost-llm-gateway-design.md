# Design: Bifrost LLM Gateway Integration

**Date:** 2026-02-26
**Status:** Approved

## Motivation

Replace the custom credential proxy (`proxy.py`) with [Bifrost](https://github.com/maximhq/bifrost), a high-performance open-source LLM gateway, to:

1. **Multi-provider support** — Route orchestrator and subagent models to any provider (Anthropic, OpenAI, Bedrock, Vertex, etc.) via Bifrost's prefix-based routing (e.g., `openai/gpt-4o-mini`)
2. **Operational benefits** — Centralized key management, weighted load balancing across API keys, automatic failover, cost tracking via Bifrost's Web UI
3. **Simplified architecture** — Remove the custom `ProxyTokenStore` and `proxy.py` in favor of Bifrost's battle-tested gateway

## Architecture

### Current Flow

```
Sidecar Container
  → proxy.py (UUID token validation → inject real ANTHROPIC_API_KEY)
  → api.anthropic.com
```

### New Flow

```
Sidecar Container
  → Bifrost /anthropic endpoint (native Anthropic Messages API)
  → Anthropic / OpenAI / Bedrock / etc.
```

Key architectural decisions:

- **Keep Claude Agent SDK unchanged** — Bifrost's `/anthropic` endpoint speaks native Anthropic Messages API, so the TypeScript SDK in the sidecar requires no code changes
- **Bifrost manages all API keys** — Real provider keys are stored in Bifrost's `config.json`, never exposed to sidecar containers
- **Sidecar gets a placeholder key** — `ANTHROPIC_API_KEY=placeholder` (Bifrost ignores client-sent keys and uses its own)
- **Two URL paths** — `BIFROST_BASE_URL` for LLM API routing, `BACKEND_BASE_URL` for MCP SSE (MCP is served by the backend, not Bifrost)

### Security Model

Equivalent to the current proxy pattern:

| Concern | Current (proxy.py) | New (Bifrost) |
|---------|-------------------|---------------|
| Real API key storage | Backend process memory | Bifrost container filesystem |
| Sidecar credential | UUID session token | Placeholder string |
| Key injection | proxy.py swaps UUID → real key | Bifrost injects stored key |
| Key exposure to sidecar | Never | Never |

Bifrost additionally supports virtual keys (`x-bf-vk` header) for per-session/per-team access control, which can be adopted later if needed.

## Docker Compose Changes

### New `bifrost` service

```yaml
bifrost:
  image: maximhq/bifrost:latest
  container_name: bifrost
  ports:
    - "${BIFROST_PORT:-8081}:8080"
  volumes:
    - ./bifrost/config.json:/app/data/config.json
  environment:
    APP_HOST: "0.0.0.0"
    ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
  networks:
    - agent-sandbox
  healthcheck:
    test: ["CMD", "wget", "--spider", "-q", "http://localhost:8080/health"]
    interval: 10s
    timeout: 5s
    retries: 3
  restart: unless-stopped
```

### Updated `app` service

```yaml
app:
  depends_on:
    bifrost:
      condition: service_healthy
  environment:
    BIFROST_BASE_URL: http://bifrost:8080
    BACKEND_BASE_URL: http://duckdb-data-agent:10000
    CONTAINER_IMAGE: duckdb-agent-sidecar:latest
    CONTAINER_NETWORK: agent-sandbox
```

Remove: `PROXY_BASE_URL`

### New `bifrost/config.json`

```json
{
  "providers": {
    "anthropic": {
      "keys": [
        {
          "name": "default",
          "value": "env.ANTHROPIC_API_KEY",
          "models": [],
          "weight": 1.0
        }
      ]
    }
  }
}
```

Additional providers (OpenAI, Bedrock, etc.) can be added to this file or via the Bifrost Web UI at `http://localhost:8081`.

## Code Changes

### Files to modify

**`backend/app/config.py`**
- Remove: `ANTHROPIC_API_KEY`, `PROXY_BASE_URL`
- Add: `BIFROST_BASE_URL` (default: `http://bifrost:8080`)
- Add: `BACKEND_BASE_URL` (default: `http://duckdb-data-agent:10000`)
- Keep: `ANTHROPIC_MODEL`, `SQL_SUBAGENT_MODEL`, `CHART_SUBAGENT_MODEL`

**`backend/app/agent.py`**
- Remove: `proxy_token_store` import, token create/revoke logic, `_delayed_revoke()`
- Replace sidecar env vars:
  ```python
  # Before
  "ANTHROPIC_API_KEY": session_token,
  "ANTHROPIC_BASE_URL": f"{PROXY_BASE_URL}/anthropic",

  # After
  "ANTHROPIC_API_KEY": "placeholder",
  "ANTHROPIC_BASE_URL": f"{BIFROST_BASE_URL}/anthropic",
  ```
- Replace MCP URL:
  ```python
  # Before
  "mcp_server_url": f"{PROXY_BASE_URL}/mcp/sse?session_id={stable_session}",

  # After
  "mcp_server_url": f"{BACKEND_BASE_URL}/mcp/sse?session_id={stable_session}",
  ```
- Remove the `finally` block's token revocation logic

**`backend/app/main.py`**
- Remove: `proxy_module` import, `app.include_router(proxy_module.router)`, proxy token cleanup in background task

### Files to delete

**`backend/app/proxy.py`** — Entire file removed (ProxyTokenStore + proxy router)

### Files to add

**`bifrost/config.json`** — Bifrost provider configuration

### Files unchanged

- `sidecar/src/server.ts` — Reads `ANTHROPIC_BASE_URL` from env; no changes needed
- `sidecar/src/types.ts` — No changes
- `backend/app/mcp_sse.py` — MCP still served by backend
- `backend/app/container_manager.py` — No changes
- Frontend — No changes

## Error Handling

- **Startup order**: `app` depends on `bifrost` with `condition: service_healthy`; Bifrost healthcheck ensures it's ready before the backend starts spawning sidecars
- **Provider failover**: Bifrost has built-in failover across providers; configured in `config.json`, not in application code
- **Error propagation**: Bifrost forwards upstream HTTP errors transparently; sidecar's existing error handling in the Claude Agent SDK remains effective

## Testing Strategy

1. **Smoke test** — `docker compose up`, verify Bifrost Web UI at `:8081`, send a chat message, confirm response flows through Bifrost
2. **Multi-provider test** — Add OpenAI key to Bifrost config, set `SQL_SUBAGENT_MODEL=openai/gpt-4o-mini`, verify subagent uses GPT-4o-mini
3. **Streaming test** — Verify SSE streaming works end-to-end through Bifrost's `/anthropic` endpoint
4. **Tool use test** — Verify Claude Agent SDK tool calls (MCP tools) work correctly when routed through Bifrost
5. **E2E regression** — Run existing Playwright E2E test suite to verify no regressions

## Multi-Provider Model Configuration

With Bifrost, model names can use provider prefixes:

| Config Variable | Example Values |
|----------------|----------------|
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6`, `anthropic/claude-sonnet-4-6` |
| `SQL_SUBAGENT_MODEL` | `haiku`, `openai/gpt-4o-mini`, `bedrock/claude-3-haiku` |
| `CHART_SUBAGENT_MODEL` | `haiku`, `openai/gpt-4o-mini` |

Bifrost routes based on the prefix. Unprefixed names default to the Anthropic provider.
