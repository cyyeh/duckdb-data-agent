# Session Context

## User Prompts

### Prompt 1

Implement the following plan:

# Sidecar SDK Refactoring: True Token-Level Streaming

## Goal
Replace CLI spawn in sidecar with `@anthropic-ai/claude-agent-sdk` TypeScript SDK to get true token-level streaming (content_block_delta events) in the container path, matching the non-container path behavior.

## Architecture
- **Sidecar**: Uses SDK `query()` with `includePartialMessages: true`, forwards raw SDK message JSON as SSE `data:` lines to backend
- **Backend**: `_stream_chat_container` handle...

### Prompt 2

also update plans of Containerized Claude Code Runtime accordingly to reflect the latest changes

### Prompt 3

you don't need to handle the case where the old sidecar image is still running

