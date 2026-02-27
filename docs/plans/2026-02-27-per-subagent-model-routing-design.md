# Per-Subagent Model Routing via @suffix Notation

**Date**: 2026-02-27

## Problem

When using a non-Anthropic model through a proxy (Bifrost, LiteLLM), all subagents
are forced to inherit the orchestrator's model (`model="inherit"`) because:

1. The Claude Agent SDK only accepts `haiku | sonnet | opus | inherit` for
   `AgentDefinition.model`. Arbitrary model strings are silently rejected.
2. The proxy may not resolve Anthropic short aliases like `haiku` to the correct
   backend model.

This prevents subagents from independently choosing a different (e.g. cheaper) model.

## Solution: `@suffix` Notation

### Env Var Format

```
REAL_MODEL@SDK_ALIAS
```

Where `SDK_ALIAS` is one of `haiku`, `sonnet`, `opus`. Examples:

```env
# Non-Anthropic via proxy (prefix is <provider>/<model> as the upstream expects)
ANTHROPIC_MODEL=openai/gpt-4o@sonnet
SQL_SUBAGENT_MODEL=openai/gpt-4o-mini@haiku
CHART_SUBAGENT_MODEL=openai/gpt-4o-mini@haiku

# Direct Anthropic (backwards compatible, no @)
ANTHROPIC_MODEL=claude-sonnet-4-6
SQL_SUBAGENT_MODEL=haiku
CHART_SUBAGENT_MODEL=haiku
```

### Parsing

A helper in `config.py` splits on `@`:

- `"openai/gpt-4o@sonnet"` → sdk_model=`"sonnet"`, real_model=`"openai/gpt-4o"`
- `"haiku"` (no `@`) → sdk_model=`"haiku"`, real_model=`"haiku"` (no rewrite)

A **model rewrite map** is built at startup from all parsed env vars. Only entries
where `real_model != sdk_model` are included.

### Proxy Model Rewriting

The backend proxy (`proxy.py`) intercepts POST requests to paths containing
`messages`. It parses the JSON body, finds the `model` field (which the SDK
resolves to full names like `claude-haiku-4-5-20251001`), and checks if it
contains a tier keyword (`haiku`, `sonnet`, `opus`). If a match exists in the
rewrite map, the model is replaced with the real model name before forwarding.

The upstream URL is configurable via `ANTHROPIC_UPSTREAM` env var (defaults to
`https://api.anthropic.com`).

**Limitation**: If two env vars use the same `@suffix` but different real models,
the last one wins. In practice this is fine — different subagents needing different
real models should use different SDK tiers.

### SDK Routing

All SDK calls go through the backend proxy (`/anthropic/`), which then forwards
to the configurable upstream. This ensures model rewriting applies to all SDK
requests regardless of mode (container or agent).

```
SDK → backend proxy (/anthropic/) → rewrite model → ANTHROPIC_UPSTREAM
```

The `/v1/models` endpoint stays as an unauthenticated passthrough so the SDK can
resolve short aliases.

### Subagent Model Passing

`SQL_SUBAGENT_MODEL` and `CHART_SUBAGENT_MODEL` are restored in `config.py`.
The parsed SDK alias is passed as `AgentDefinition.model`. The `"inherit"`
fallback remains when no subagent model is configured.

## File Changes

| File | Change |
|------|--------|
| `backend/app/config.py` | Add `parse_model()` helper, restore subagent model vars, export rewrite map |
| `backend/app/proxy.py` | Add model rewriting on POST requests, configurable `ANTHROPIC_UPSTREAM` |
| `backend/app/agent.py` | Route `ANTHROPIC_BASE_URL` through backend proxy, use parsed SDK models |
| `backend/.env.example` | Document `@suffix` format |
