# Session Context

## User Prompts

### Prompt 1

Implement the following plan:

# Fix: Persist message edit/delete across conversation switches

## Context

When a user edits or deletes a message in a conversation, then switches to another conversation and switches back, the changes are lost. The edit/delete only modifies React state but never persists to the backend database. When switching back, `selectConversation` fetches from `GET /api/conversations/:id`, which returns the original unmodified messages.

## Root Cause

1. **`deleteMessage`...

