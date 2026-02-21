# Credential Proxy Design

**Date:** 2026-02-21
**Status:** Approved

## Problem

The server runs `claude-agent-sdk` which spawns Claude Code CLI as a subprocess. The subprocess inherits the parent process environment, including `CLAUDE_CODE_OAUTH_TOKEN`. A malicious user could craft a prompt to extract this token (e.g., `import os; print(os.environ)`), compromising the shared server account.

## Solution

A local reverse proxy runs inside the FastAPI app. Each chat session receives a short-lived UUID token. The Claude Code subprocess is given this UUID plus a `ANTHROPIC_BASE_URL` pointing to the local proxy. The proxy validates the UUID and swaps it for the real `CLAUDE_CODE_OAUTH_TOKEN` before forwarding to `api.anthropic.com`.

Even if a user extracts the UUID via prompt injection, it is useless outside `localhost` and expires when the chat session ends.

## Architecture

```
[Server startup]
  1. Read real token from CLAUDE_CODE_OAUTH_TOKEN env var → store in memory

[POST /api/chat]
  2. Generate session UUID token
  3. Register UUID → {expiry} in ActiveSessionTokens (TTL = chat session)
  4. Pass to ClaudeAgentOptions(
       env={
         "CLAUDE_CODE_OAUTH_TOKEN": "<session-uuid>",
         "ANTHROPIC_BASE_URL": "http://127.0.0.1:10000/anthropic",
       }
     )
  5. Claude Code subprocess sends Bearer <session-uuid> to local proxy

[/anthropic/{path:path}]
  6. Extract Bearer token from Authorization header
  7. Validate it's a registered, non-expired session UUID
  8. Replace Authorization → "Bearer <real CLAUDE_CODE_OAUTH_TOKEN>"
  9. Forward full request + body to https://api.anthropic.com/{path}
 10. Stream response back to Claude Code subprocess

[SSE done/error event in agent.py]
 11. Revoke session UUID from ActiveSessionTokens
```

## Components

| File | Change |
|---|---|
| `backend/app/proxy.py` | New — `ProxyTokenStore` + `/anthropic/{path}` FastAPI router |
| `backend/app/agent.py` | Inject `env=` in `ClaudeAgentOptions`; accept token arg; revoke on done/error |
| `backend/app/main.py` | Include proxy router |
| `backend/app/config.py` | Read `CLAUDE_CODE_OAUTH_TOKEN` from env |

## Key Details

### Env injection

`subprocess_cli.py` builds the subprocess env as:
```python
process_env = {**os.environ, **options.env, ...}
```
`options.env` overrides win, so setting `CLAUDE_CODE_OAUTH_TOKEN` in `options.env` prevents the subprocess from seeing the real token in `os.environ`.

### Token store

In-memory dict: `{uuid: expiry_datetime}`. Tokens are created at chat start and deleted on `done`/`error` SSE events. No persistence needed — tokens are ephemeral.

### Proxy forwarding

Uses `httpx.AsyncClient` to forward the full request (method, headers, body) to `https://api.anthropic.com`, streaming the response back. The only header modification is replacing `Authorization`.

### Security properties

- Subprocess never sees real `CLAUDE_CODE_OAUTH_TOKEN`
- UUID token is useless outside `localhost`
- Token expires at session end (revoked explicitly, not just by TTL)
- No OAuth refresh logic needed — proxy forwards the long-lived token as-is

## Out of Scope

- Per-user OAuth (all users share one server account)
- Rate limiting per session (separate concern)
- Persistent token storage
