# Session Context

## User Prompts

### Prompt 1

Implement the following plan:

# Plan: Add fallback model rewrite for unmapped models

## Context

The Claude Agent SDK's WebFetch tool internally uses `claude-haiku-4-5-20251001`. When all models are configured to route through OpenAI (e.g., `openai/gpt-5.2-2025-12-11@sonnet`), only `sonnet` is in `MODEL_REWRITES`. The haiku model passes through unchanged, and Bifrost fails with `"provider is required"` because the bare model name lacks a provider prefix and no Anthropic API key is configured.
...

### Prompt 2

also update readme about DEFAULT_TOOL_MODEL

