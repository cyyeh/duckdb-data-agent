# Survey: Adding Skills Capability to Claude Agent SDK

## Executive Summary

The Claude Agent SDK (Python `0.1.44`, TypeScript `0.2.63`) is a thin wrapper around the Claude Code CLI subprocess. It does **not** call the Anthropic API directly — it spawns a `claude` binary and communicates via JSON streaming over stdin/stdout.

Claude Code's skills system is a **plugin-based progressive disclosure** mechanism that injects specialized knowledge into Claude's context on demand. Skills are markdown files with YAML frontmatter, discovered at session start and loaded via the `Skill` tool when triggered.

The key question is: **how can we bring skills-like capability to applications built with the Claude Agent SDK?**

---

## Part 1: Claude Agent SDK Architecture

### Core Abstractions

| Concept | Python | TypeScript |
|---------|--------|------------|
| Main entry | `query(prompt, options)` → async generator of `Message` | `query({prompt, options})` → `AsyncGenerator<SDKMessage>` |
| Interactive client | `ClaudeSDKClient` (bidirectional, multi-turn) | N/A (use `query` directly) |
| Agent config | `ClaudeAgentOptions` dataclass | `Options` interface |
| Subagent def | `AgentDefinition(description, prompt, tools, model)` | `AgentDefinition` (adds `skills`, `disallowedTools`, `mcpServers`, `maxTurns`) |

### Transport Layer

Both SDKs use `SubprocessCLITransport`:
1. Find the bundled `claude` CLI binary
2. Spawn it with `--output-format stream-json --input-format stream-json`
3. Send `initialize` control request with agents, hooks via stdin
4. Stream messages via stdout as newline-delimited JSON

### Tool System

Tools come from two sources:
- **Built-in CLI tools**: `Task`, `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, etc.
- **MCP servers**: External tools registered via `mcpServers` config (SSE or stdio transport)
- **SDK MCP servers**: In-process tools via `create_sdk_mcp_server()` / `createSdkMcpServer()`

### Subagent System

The `Task` built-in tool dispatches to subagents defined in `AgentDefinition`:
- Registered at session init via the `agents` dict in options
- Each subagent has its own system prompt, allowed tools, and model
- Subagent results: metadata in `tool_result`, actual text in intermediate messages with `parent_tool_use_id`

### Extensibility Points

| Mechanism | Description | Skills Relevance |
|-----------|-------------|------------------|
| **Hook system** | Callbacks for lifecycle events (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, etc.) | Could inject skill context via hooks |
| **`can_use_tool` callback** | Permission gate before every tool call | Can allow/deny/modify tool inputs |
| **Agent definitions** | Register subagents with custom prompts and tools | Skills could be specialized subagents |
| **`skills` field (TS only)** | `AgentDefinition.skills?: string[]` — array of skill names | Direct skill support exists in TS SDK type! |
| **Plugin system** | `plugins` option, `--plugin-dir` CLI flag | Could package skills as plugins |
| **SDK MCP servers** | In-process tool servers | Add custom tools without external processes |
| **Custom transport** | Replace the CLI subprocess entirely | Full control over communication |

### Key Insight: TypeScript SDK Already Has `skills` Field

The TypeScript SDK's `AgentDefinition` type includes:
```typescript
skills?: string[];  // Array of skill names to preload into agent context
```
This field does **not** exist in Python SDK `0.1.44`, suggesting skills support is a newer TypeScript-side feature being built into the CLI.

---

## Part 2: Claude Code Skills System

### What Are Skills?

Skills are modular, self-contained markdown documents that provide Claude with specialized procedural knowledge. They follow **progressive disclosure**:

1. **Metadata** (always in context): `name` + `description` from YAML frontmatter
2. **Full content** (on demand): Loaded when Claude invokes the `Skill` tool
3. **Resources** (as needed): Scripts, references, assets in subdirectories

### Skill File Format

```
skill-name/
├── SKILL.md              # Required - main skill definition
├── scripts/              # Optional - executable scripts
├── references/           # Optional - reference docs
├── examples/             # Optional - example files
└── assets/               # Optional - templates, images
```

**SKILL.md structure:**
```markdown
---
name: skill-name-with-hyphens
description: Use when [triggering conditions]. Start with "Use when..."
---

# Skill Title

## Overview
Core principle in 1-2 sentences.

## When to Use / Core Pattern / Implementation / Common Mistakes
```

**Frontmatter rules:**
- Only `name` and `description` required
- Max 1024 characters total
- `name`: letters, numbers, hyphens only
- `description`: Describes WHEN to use (triggering conditions), not WHAT it does

### Skill Types

| Dimension | Types |
|-----------|-------|
| Behavioral | **Rigid** (follow exactly: TDD, debugging) vs **Flexible** (adapt: brainstorming, patterns) |
| Conceptual | **Technique** (concrete steps) vs **Pattern** (ways of thinking) vs **Reference** (docs/guides) |

### How Skills Are Discovered and Loaded

1. **Session start**: `SessionStart` hook injects `using-superpowers/SKILL.md` into system prompt
2. **Metadata injection**: All skill `name` + `description` pairs listed in system prompt
3. **On-demand loading**: Claude calls `Skill` tool → full SKILL.md content loaded into context
4. **Resolution order**: Personal skills (`~/.claude/skills/`) shadow plugin skills

```javascript
// From skills-core.js
function resolveSkillPath(skillName, superpowersDir, personalDir) {
    // "superpowers:brainstorming" → force plugin lookup
    // "brainstorming" → check personal first, then plugin
}
```

### Plugin System (Skill Distribution)

```
plugin-name/
├── .claude-plugin/plugin.json    # Manifest
├── commands/                      # Slash commands (.md)
├── agents/                        # Subagent definitions (.md)
├── skills/                        # Skills (SKILL.md in subdirs)
├── hooks/hooks.json               # Event hooks
├── .mcp.json                      # MCP servers (optional)
└── scripts/                       # Utilities
```

**Installation**: Plugins installed via `/plugin install name@marketplace`
**Marketplaces**: `claude-plugins-official` (Anthropic), `superpowers-marketplace` (community)
**Registry**: `~/.claude/plugins/installed_plugins.json` tracks all installed plugins
**Enabling**: `~/.claude/settings.json` → `enabledPlugins` map

### Components Comparison

| Component | Invocation | Purpose |
|-----------|------------|---------|
| **Commands** | User types `/command` | User-initiated workflows |
| **Skills** | Claude invokes `Skill` tool | On-demand knowledge injection |
| **Agents** | Claude spawns as subagent | Specialized sub-tasks |

---

## Part 3: Gap Analysis — What's Needed for SDK Skills

### What Claude Code Has That the SDK Lacks

| Capability | Claude Code | Agent SDK |
|------------|-------------|-----------|
| Skill discovery | `SessionStart` hook + metadata injection | No equivalent |
| Skill loading | `Skill` tool reads SKILL.md | No `Skill` tool |
| Skill invocation protocol | `using-superpowers` meta-skill in system prompt | No protocol |
| Plugin system | Full marketplace + install + versioning | `--plugin-dir` CLI flag only |
| Progressive disclosure | 3-level: metadata → content → resources | System prompt only |
| Personal skills | `~/.claude/skills/` with shadowing | Not supported |

### Possible Approaches

#### Approach A: Leverage Existing CLI Skills via `--plugin-dir`

The SDK passes `--plugin-dir` to the CLI subprocess. If skills are packaged as plugins, the CLI may already support loading them.

**Pros**: Minimal SDK changes, leverages existing CLI infrastructure
**Cons**: Depends on CLI behavior, limited control, requires Claude Code CLI to be installed
**Investigation needed**: Does the CLI load skills from `--plugin-dir`? Does it inject skill metadata into context?

#### Approach B: System Prompt Injection

Manually inject skill metadata and content into the system prompt passed to the SDK.

```python
skill_catalog = load_skill_metadata("./skills/")  # Read all SKILL.md frontmatter
system_prompt = f"""
{base_prompt}

# Available Skills
{format_skill_catalog(skill_catalog)}

When you need specialized knowledge, request a skill by name.
"""
```

**Pros**: Works today, no SDK changes needed, full control
**Cons**: No progressive disclosure (all content in prompt), no `Skill` tool, manual implementation

#### Approach C: SDK MCP Server as Skill Provider

Create an in-process MCP server that exposes a `load_skill` tool:

```python
@tool("load_skill", "Load a skill by name", {"skill_name": str})
async def load_skill(args):
    content = read_skill_md(args["skill_name"])
    return {"content": [{"type": "text", "text": content}]}

server = create_sdk_mcp_server("skills", tools=[load_skill])
options = ClaudeAgentOptions(
    system_prompt=f"{base_prompt}\n\n{skill_catalog}",
    sdk_mcp_servers=[server],
)
```

**Pros**: Progressive disclosure via tool calls, works with current SDK, clean API
**Cons**: Need to teach the agent to call `load_skill` (system prompt instruction), no built-in `Skill` tool name

#### Approach D: Use TypeScript SDK's `skills` Field

The TypeScript `AgentDefinition` already has `skills?: string[]`. This suggests the CLI has (or is building) native skill support for subagents.

```typescript
const agents = {
  "sql-analyst": {
    description: "...",
    prompt: "...",
    tools: ["execute_sql"],
    skills: ["data-analysis", "sql-optimization"],  // <-- native support?
  }
};
```

**Pros**: Native SDK support, first-class integration
**Cons**: Only TypeScript, Python SDK doesn't have this field yet, behavior unclear

#### Approach E: Hook-Based Skill Injection

Use the hook system to inject skill content at key lifecycle moments:

```python
hooks = {
    "UserPromptSubmit": [HookMatcher(hooks=[inject_skill_context])],
    "PreToolUse": [HookMatcher(matcher="Task", hooks=[inject_subagent_skills])],
}
```

**Pros**: Event-driven, can adapt to context
**Cons**: Hook callbacks have limited modification power, can only add `additionalContext`

### Recommended Path

**Start with Approach C (SDK MCP Server)** for immediate capability, combined with **investigating Approach D** (native `skills` field) for long-term alignment with the SDK roadmap.

Approach C gives us:
- Progressive disclosure (skill content loaded on demand via tool)
- Clean separation (skills are files, served via MCP)
- Works with both Python and TypeScript SDKs today
- Matches the Claude Code pattern (skill metadata in prompt, content via tool)

---

## Part 4: This Project's Current Architecture

### How the duckdb-data-agent Uses the SDK

```
Frontend (React) → Backend (FastAPI) → Sidecar (TS in Docker) → Claude CLI subprocess
                         ↕
                    MCP SSE Server
                    ├── execute_sql
                    ├── ask_user_question
                    └── render_chart
```

**Agent mode** (local): Python SDK directly spawns CLI
**Container mode** (Docker): Backend POSTs to sidecar, which uses TypeScript SDK

### Current Subagent: `sql-analyst`

Only one subagent exists, with:
- Custom system prompt for SQL analysis
- Restricted to `execute_sql` tool only
- Model inherits from orchestrator

### Where Skills Would Add Value

1. **Domain-specific analysis patterns**: Skills for time-series analysis, cohort analysis, funnel analysis, etc.
2. **Chart selection guidance**: Skill for choosing appropriate visualization types
3. **SQL optimization**: Skill for DuckDB-specific query patterns
4. **Data quality checks**: Skill for identifying data issues and cleaning strategies

---

## Key Files Referenced

| File | Role |
|------|------|
| `backend/app/agent.py` | Orchestrator, session mgmt, SSE translation |
| `backend/app/mcp_sse.py` | MCP server with 3 tools |
| `backend/app/config.py` | Model configuration |
| `sidecar/src/server.ts` | TypeScript SDK wrapper in Docker |
| `backend/pyproject.toml` | Python deps (`claude-agent-sdk ^0.1.44`) |
| `sidecar/package.json` | TS deps (`@anthropic-ai/claude-agent-sdk ^0.2.62`) |
| `backend/.venv/.../claude_agent_sdk/types.py` | Python SDK types |
| `sidecar/node_modules/.../sdk.d.ts` | TypeScript SDK types |
