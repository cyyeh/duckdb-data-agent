# Survey: Memory Capabilities in Claude Agent SDK

## Current State of This Project

This project uses a **stateless, request-scoped conversation history model**:

- **Frontend**: All conversation history lives in React component state (`messages` in `AgentContext.tsx`). Lost on page refresh.
- **Backend**: History is passed request-by-request from the frontend as `conversation_history: list[dict]`. No persistent store.
- **Sidecar**: Uses Claude Agent SDK's `--resume` flag for short-term session continuity within a container. Falls back to prepending history to the prompt if resume fails.
- **No cross-session persistence**: No database, no long-context retrieval, no cross-device support.

Key files:
- `backend/app/agent.py` (lines 137-264): Resume strategy and history injection
- `sidecar/src/server.ts` (lines 225-359): Resume fallback logic
- `frontend/src/contexts/AgentContext.tsx` (lines 77-94): History building per request

---

## Available Memory Mechanisms in Claude Agent SDK

### 1. Session Management (Agent SDK Layer)

**Docs**: https://platform.claude.com/docs/en/agent-sdk/sessions

Built-in session management for maintaining conversation state across interactions.

| Feature | Description |
|---------|-------------|
| **Session creation** | Automatic on `query()` call; session ID emitted in first `system` message with `subtype: "init"` |
| **Session resumption** | Pass `resume=session_id` to restore full conversation history |
| **Session forking** | `fork_session=True` creates independent conversation branches |
| **ClaudeSDKClient** | Interactive stateful sessions maintaining context across multiple `query()` calls |

Sessions persist to disk at `~/.claude/projects/` by default.

### 2. Memory Tool (Claude API Layer) — Beta

**Docs**: https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool

A client-side tool (`type: memory_20250818`) enabling Claude to store/retrieve information across conversations via a file-based memory directory.

**How it works:**
- Claude checks `/memories` directory before starting tasks
- Creates, reads, updates, deletes files in that directory
- **Client-side**: your application executes the file operations (filesystem, DB, cloud, etc.)

**Operations**: `view`, `create`, `str_replace`, `insert`, `delete`, `rename`

**Usage:**
```python
client.messages.create(
    model="claude-opus-4-6",
    max_tokens=2048,
    messages=[...],
    tools=[{"type": "memory_20250818", "name": "memory"}],
)
```

**SDK helpers:**
- Python: Subclass `BetaAbstractMemoryTool` for custom backends
- TypeScript: Use `betaMemoryTool` helper

**Built-in protocol**: When enabled, Claude automatically views memory before doing anything and records progress as it works.

### 3. Server-Side Compaction — Beta

**Docs**: https://platform.claude.com/docs/en/build-with-claude/compaction

Automatically summarizes older conversation context when approaching the context window limit.

- **Beta header**: `compact-2026-01-12`
- **Default trigger**: 150,000 input tokens (minimum 50,000)
- **Supported models**: Claude Opus 4.6, Sonnet 4.6
- Supports `pause_after_compaction` for injecting preserved messages
- Custom summarization instructions via `instructions` parameter

```python
response = client.beta.messages.create(
    betas=["compact-2026-01-12"],
    model="claude-opus-4-6",
    max_tokens=4096,
    messages=messages,
    context_management={
        "edits": [{"type": "compact_20260112",
                    "trigger": {"type": "input_tokens", "value": 100000}}]
    },
)
```

### 4. Context Editing — Beta

**Docs**: https://platform.claude.com/docs/en/build-with-claude/context-editing

Fine-grained control over what gets cleared from conversation history.

- **Beta header**: `context-management-2025-06-27`
- **Tool Result Clearing** (`clear_tool_uses_20250919`): Clears oldest tool results chronologically
- **Thinking Block Clearing** (`clear_thinking_20251015`): Manages `thinking` blocks

Can be combined with memory tool (exclude memory calls from clearing):
```python
context_management={
    "edits": [{"type": "clear_tool_uses_20250919", "exclude_tools": ["memory"]}]
}
```

### 5. CLAUDE.md Files (Project-Level)

**Docs**: https://platform.claude.com/docs/en/agent-sdk/modifying-system-prompts

Persistent, version-controllable "memory" for projects:
- Project-level: `CLAUDE.md` or `.claude/CLAUDE.md`
- User-level: `~/.claude/CLAUDE.md`
- Loaded with `setting_sources=["project"]`

### 6. MCP-Based Memory Servers

The Agent SDK can consume any MCP server via `mcp_servers` configuration, enabling pluggable memory backends (Redis, PostgreSQL, vector DBs, etc.).

---

## Multi-Session Memory Pattern

**Source**: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents

Recommended pattern for projects spanning multiple agent sessions:

1. **Initializer Session**: Creates progress log + feature checklist in memory files
2. **Subsequent Sessions**: Opens by reading memory artifacts to recover state
3. **End-of-Session Update**: Updates progress log before session ends

---

## Third-Party Integrations

| Integration | Description |
|-------------|-------------|
| **Cognee** | Knowledge graph-based memory via MCP; vector similarity + graph traversal |
| **claude-mem** | Claude Code plugin storing session data in SQLite |
| **Custom MCP servers** | Any MCP-compatible memory server can be plugged in |

---

## Summary Comparison

| Mechanism | Layer | Persistence | Scope | Built-in? | Use Case |
|-----------|-------|-------------|-------|-----------|----------|
| Session Management | Agent SDK | Disk (~/.claude) | Per-session | Yes | Resume/fork conversations |
| Memory Tool | Claude API | Developer-controlled | Cross-session | Yes (beta) | Persistent knowledge files |
| Server-Side Compaction | Claude API | Within-request | Per-conversation | Yes (beta) | Long conversations beyond 200K |
| Context Editing | Claude API | N/A (clearing) | Per-request | Yes (beta) | Fine-grained context curation |
| CLAUDE.md | Agent SDK | File system (git) | Per-project | Yes | Project context & guidelines |
| MCP Memory Servers | Agent SDK + MCP | Developer-controlled | Cross-session | Via integration | Custom memory backends |

---

## Key Limitations

1. **No built-in vector store** — must bring your own via MCP or custom implementation
2. **Memory tool is client-side** — all storage is the developer's responsibility
3. **No automatic cross-session memory** — requires explicit session IDs or memory tool
4. **Compaction loses detail** — summaries replace full history
5. **Same model for compaction** — cannot use a cheaper model for server-side summaries (client-side compaction supports this)

---

## References

### Official Documentation
- [Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Session Management](https://platform.claude.com/docs/en/agent-sdk/sessions)
- [Memory Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- [Server-Side Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)
- [Context Editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)

### Engineering Blog Posts
- [Building Agents with the Claude Agent SDK](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)
- [Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

### Packages
- [Python SDK on PyPI](https://pypi.org/project/claude-agent-sdk/) (v0.1.44)
- [TypeScript SDK on npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)

### Third-Party
- [Cognee Integration Guide](https://www.cognee.ai/blog/integrations/claude-agent-sdk-persistent-memory-with-cognee-integration)
- [Claude-Mem Plugin](https://github.com/thedotmack/claude-mem)
