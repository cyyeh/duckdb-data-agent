# Claude Gateway: Multi-Provider Model Support via LiteLLM

**Date:** 2026-02-26
**Status:** Approved

## Problem

The application is locked to Anthropic models. Users who want to use OpenAI, Google Gemini, Mistral, or other providers must wait for native support or switch tools entirely.

## Solution

Embed a LiteLLM-based translation layer in the existing credential proxy (`proxy.py`). When the Claude Agent SDK makes API calls through the proxy, the gateway detects whether the target model is Anthropic or non-Anthropic and routes accordingly:

- **Anthropic models** -> forward to `api.anthropic.com` (existing behavior, unchanged)
- **Non-Anthropic models** -> use LiteLLM to translate the Anthropic Messages API request to the target provider's format, call the provider, and translate the response back to Anthropic format

The sidecar, Claude Agent SDK, frontend, and agent logic remain completely untouched.

```
SDK -> POST /anthropic/v1/messages -> proxy.py
  |-- model=claude-* -> forward to api.anthropic.com (existing)
  |-- model=gpt-4o   -> gateway.py -> LiteLLM -> openai.com -> translate response -> Anthropic format
```

## Architecture

### Model Detection & Routing

A helper function `is_anthropic_model(model_name)` classifies model names:

- **Anthropic:** `claude-*`, plus short aliases `haiku`, `sonnet`, `opus`
- **Non-Anthropic:** everything else, using LiteLLM's naming convention (`gpt-4o`, `gemini/gemini-2.0-flash`, `mistral/mistral-large-latest`, `ollama/llama3`, etc.)

Routing in `proxy.py` intercepts `POST` requests to `v1/messages`. All other paths forward to Anthropic as before, except `GET v1/models` which is augmented (see below).

```python
# In proxy_anthropic(), simplified:
if method == "POST" and path == "v1/messages":
    body = parse_json(request)
    model = body.get("model", "")
    if not is_anthropic_model(model):
        return await gateway_handler(body, stream=body.get("stream", False))
# Otherwise fall through to existing upstream forwarding
```

### Model Alias Resolution (`/v1/models`)

The Claude Agent SDK calls `GET /v1/models` to resolve short aliases (e.g., `haiku` -> `claude-haiku-4-5-20251001`) for both orchestrator and subagent models. Non-Anthropic model names would fail this resolution.

Solution: always intercept `GET /v1/models`:

1. Forward to `api.anthropic.com` to get real Anthropic models
2. Collect all configured non-Anthropic model names from env vars (`ANTHROPIC_MODEL`, `SQL_SUBAGENT_MODEL`, `CHART_SUBAGENT_MODEL`)
3. Append synthetic entries for non-Anthropic models so the SDK's alias resolution accepts them

This enables mixed-provider configurations:
```bash
ANTHROPIC_MODEL=gpt-4o                        # orchestrator on OpenAI
SQL_SUBAGENT_MODEL=haiku                       # subagent on Anthropic
CHART_SUBAGENT_MODEL=gemini/gemini-2.0-flash   # subagent on Google
```

### Request/Response Translation (`gateway.py`)

New module `backend/app/gateway.py` handles bidirectional translation using LiteLLM.

**Non-streaming flow:**

1. Receive Anthropic Messages API request body (`model`, `messages`, `system`, `tools`, `max_tokens`, etc.)
2. Convert to OpenAI-compatible format (LiteLLM's internal standard)
3. Call `litellm.acompletion(model="gpt-4o", messages=[...], tools=[...])`
4. Convert the OpenAI-format response back to Anthropic Messages API response (`content` blocks with `type: "text"` / `type: "tool_use"`, `stop_reason`, `usage`, etc.)
5. Return as JSON HTTP response

**Streaming flow:**

1. Same request translation
2. Call `litellm.acompletion(model="gpt-4o", ..., stream=True)`
3. Convert each OpenAI streaming chunk to Anthropic SSE events:
   - Emit `message_start` with message metadata
   - Convert `choices[].delta.content` -> `content_block_delta` with `text_delta`
   - Convert `choices[].delta.tool_calls` -> `content_block_start` + `content_block_delta` with `input_json_delta`
   - Emit `message_delta` with `stop_reason` and final `usage`
   - Emit `message_stop`
4. Yield as `text/event-stream` response

**Tool use round-trip (critical path):**

- **Request direction:** Anthropic `tools` array (name, description, input_schema) -> OpenAI `tools` array (function name, description, parameters). Straightforward mapping.
- **Response direction:** OpenAI `tool_calls` (function name, arguments as JSON string) -> Anthropic `tool_use` content blocks (name, input as parsed object, unique `id`).
- **Tool results:** Anthropic `tool_result` messages (with `tool_use_id`) -> OpenAI `tool` role messages. LiteLLM handles this natively.

### Configuration

**Existing env vars** get broader meaning -- they now accept any LiteLLM model name:

- `ANTHROPIC_MODEL` -- orchestrator model (default: `claude-sonnet-4-6`)
- `SQL_SUBAGENT_MODEL` -- sql analyst subagent (default: `haiku`)
- `CHART_SUBAGENT_MODEL` -- chart builder subagent (default: `haiku`)

**New env vars** for provider API keys (LiteLLM reads these automatically from the environment):

- `OPENAI_API_KEY` -- for GPT models
- `GEMINI_API_KEY` -- for Google Gemini
- `MISTRAL_API_KEY` -- for Mistral
- `GROQ_API_KEY` -- for Groq
- Any other provider key supported by LiteLLM

`ANTHROPIC_API_KEY` warning in `config.py` is relaxed -- it's no longer required if using only non-Anthropic providers.

## Files Changed

| File | Change |
|---|---|
| `backend/app/gateway.py` | **New** -- LiteLLM translation layer (~250 lines) |
| `backend/app/proxy.py` | Modify routing to detect non-Anthropic models and delegate to gateway; augment `/v1/models` response |
| `backend/app/config.py` | Relax `ANTHROPIC_API_KEY` warning |
| `backend/.env.example` | Add provider key examples and non-Anthropic model examples |
| `backend/pyproject.toml` | Add `litellm` dependency |

**No changes to:** sidecar, frontend, agent.py, container_manager, MCP tools.

## Limitations

- **Anthropic-specific features** (prompt caching, extended thinking, citations, PDF input) are silently dropped for non-Anthropic models
- **Tool use quality varies** across providers -- GPT-4o and Gemini handle multi-step tool chains well, smaller/open-source models may struggle
- **Streaming latency** -- adds one translation hop but no extra network round-trips
- **Provider-specific errors** need translation to Anthropic error format for the SDK to handle gracefully
