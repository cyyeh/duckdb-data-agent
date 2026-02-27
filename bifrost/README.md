# Bifrost LLM Gateway Configuration

This directory contains the configuration for the [Bifrost](https://github.com/maximhq/bifrost) LLM gateway, which manages API keys and routes LLM requests to multiple providers.

## Configuration

Edit `config.json` to add or modify providers. Bifrost reads this file on startup.

### Structure

```json
{
  "providers": {
    "<provider-name>": {
      "keys": [
        {
          "name": "<unique-key-name>",
          "value": "env.<ENV_VAR_NAME>",
          "models": [],
          "weight": 1.0
        }
      ]
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `value` | API key. Use `"env.VAR_NAME"` to read from environment variables (recommended). |
| `models` | Restrict this key to specific models. Empty array `[]` = all models. |
| `weight` | Traffic distribution weight across multiple keys (e.g., `0.7` = 70% of requests). |

### Adding Providers

**Anthropic** (default, already configured):

```json
"anthropic": {
  "keys": [{ "name": "default", "value": "env.ANTHROPIC_API_KEY", "models": [], "weight": 1.0 }]
}
```

**OpenAI:**

```json
"openai": {
  "keys": [{ "name": "default", "value": "env.OPENAI_API_KEY", "models": [], "weight": 1.0 }]
}
```

**AWS Bedrock:**

```json
"bedrock": {
  "keys": [{
    "name": "default",
    "models": [],
    "weight": 1.0,
    "bedrock_key_config": {
      "access_key": "env.AWS_ACCESS_KEY_ID",
      "secret_key": "env.AWS_SECRET_ACCESS_KEY",
      "region": "us-east-1"
    }
  }]
}
```

**Google Vertex AI:**

```json
"vertex": {
  "keys": [{
    "name": "default",
    "value": "env.VERTEX_API_KEY",
    "models": [],
    "weight": 1.0,
    "vertex_key_config": {
      "project_id": "env.VERTEX_PROJECT_ID",
      "region": "us-central1",
      "auth_credentials": "env.VERTEX_CREDENTIALS"
    }
  }]
}
```

**Self-Hosted (vLLM):**

```json
"vllm": {
  "keys": [{ "name": "default", "value": "dummy", "models": [], "weight": 1.0 }],
  "network_config": {
    "base_url": "http://localhost:8000",
    "default_request_timeout_in_seconds": 300
  },
  "custom_provider_config": {
    "base_provider_type": "openai",
    "allowed_requests": { "chat_completion": true, "chat_completion_stream": true }
  }
}
```

**Self-Hosted (Ollama):**

```json
"ollama": {
  "keys": [{ "name": "default", "value": "dummy", "models": [], "weight": 1.0 }],
  "network_config": {
    "base_url": "http://localhost:11434",
    "default_request_timeout_in_seconds": 300
  },
  "custom_provider_config": {
    "base_provider_type": "openai",
    "allowed_requests": { "chat_completion": true, "chat_completion_stream": true }
  }
}
```

Self-hosted providers use `custom_provider_config` with `base_provider_type: "openai"` since vLLM and Ollama expose OpenAI-compatible APIs. The `value` can be `"dummy"` as these servers typically don't require API keys. Adjust `base_url` if your server is on a different host (use `http://host.docker.internal:<port>` when Bifrost runs in Docker and the LLM server is on the host).

### Example: Multi-Provider Setup

```json
{
  "providers": {
    "anthropic": {
      "keys": [{ "name": "default", "value": "env.ANTHROPIC_API_KEY", "models": [], "weight": 1.0 }]
    },
    "openai": {
      "keys": [{ "name": "default", "value": "env.OPENAI_API_KEY", "models": [], "weight": 1.0 }]
    }
  }
}
```

Then set subagent models to use the desired provider via prefix:

```
SQL_SUBAGENT_MODEL=openai/gpt-4o-mini
CHART_SUBAGENT_MODEL=openai/gpt-4o-mini
```

For self-hosted models:

```
ORCHESTRATOR_MODEL=vllm/qwen2.5-coder@sonnet
SQL_SUBAGENT_MODEL=ollama/qwen2.5-coder@haiku
```

### Environment Variables

API keys referenced via `env.VAR_NAME` must be available in the Bifrost container's environment. They are loaded from `backend/.env` via the `env_file` directive in `docker-compose.yml`.

To add a new provider key, add the env var to `backend/.env`:

```
OPENAI_API_KEY=sk-...
```

### Web UI

Bifrost also provides a web UI for managing configuration at `http://localhost:8081` (or `$BIFROST_PORT`). Changes made via the UI are persisted in the config database alongside `config.json`.

### Documentation

For full configuration options, see the [Bifrost documentation](https://docs.getbifrost.ai/).
