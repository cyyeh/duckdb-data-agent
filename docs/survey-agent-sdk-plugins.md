# Survey: Plugins Capability in Claude Agent SDK

## Executive Summary

The Claude Agent SDK (Python `claude-agent-sdk`, TypeScript `@anthropic-ai/claude-agent-sdk`) supports a **plugin system** that allows loading self-contained extension packages into agent sessions. Plugins are the primary distribution and sharing mechanism for extending Claude Code with custom **skills**, **commands**, **agents**, **hooks**, **MCP servers**, and **LSP servers**.

The plugin system solves the problem of **reusable, shareable, and composable agent extensions**. Rather than configuring each extension point individually (skills in `.claude/skills/`, hooks in settings, MCP servers in `.mcp.json`), plugins bundle all of these into a single directory with a manifest file. Plugins can be distributed via marketplaces, installed with a single command, version-controlled, and shared across projects and teams.

At the SDK level, plugins are loaded by passing filesystem paths through the `plugins` option in `ClaudeAgentOptions`. The SDK translates these into `--plugin-dir` arguments for the underlying Claude Code CLI subprocess. Only `"local"` type plugins (filesystem paths) are currently supported.

---

## Part 1: What Plugins Are and What Problem They Solve

### The Problem

Before plugins, extending Claude Code required scattering configuration across multiple locations:

| Extension Type | Standalone Location | Limitation |
|---------------|---------------------|------------|
| Skills | `.claude/skills/` | Project-specific, manual copy to share |
| Commands | `.claude/commands/` | Project-specific, no namespacing |
| Hooks | `settings.json` | Tied to settings file, hard to distribute |
| MCP servers | `.mcp.json` | Per-project, no bundling with related configs |
| Agents | `.claude/agents/` | Project-specific |

### The Solution

Plugins bundle all extension types into a **single, self-contained directory** with:

- A **manifest** (`.claude-plugin/plugin.json`) for metadata and configuration
- **Automatic namespacing** to prevent conflicts between plugins (e.g., `/my-plugin:hello`)
- **Marketplace distribution** for easy installation via `/plugin install`
- **Versioning** with semantic versioning support
- **Scoped installation** (user, project, local, managed)

### Plugins vs Standalone Configuration

| Approach | Skill Names | Best For |
|----------|-------------|----------|
| **Standalone** (`.claude/` directory) | `/hello` | Personal workflows, project-specific, quick experiments |
| **Plugins** (`.claude-plugin/plugin.json`) | `/plugin-name:hello` | Sharing, distribution, versioned releases, cross-project reuse |

---

## Part 2: Plugin Structure and Manifest

### Directory Structure

A plugin is a directory with the following layout:

```
my-plugin/
├── .claude-plugin/           # Metadata directory
│   └── plugin.json           # Required: plugin manifest
├── commands/                 # Slash commands (Markdown files)
│   └── example-command.md
├── agents/                   # Custom agent definitions (Markdown)
│   └── specialist.md
├── skills/                   # Agent Skills
│   └── my-skill/
│       └── SKILL.md
├── hooks/                    # Event handlers
│   └── hooks.json
├── settings.json             # Default settings for plugin
├── .mcp.json                 # MCP server definitions
├── .lsp.json                 # LSP server configurations
├── scripts/                  # Hook and utility scripts
│   └── format-code.sh
├── LICENSE
└── README.md
```

**Important**: Components (`commands/`, `agents/`, `skills/`, `hooks/`) must be at the plugin root level, NOT inside `.claude-plugin/`. Only `plugin.json` goes inside `.claude-plugin/`.

### Plugin Manifest (`plugin.json`)

The manifest is optional. If omitted, Claude Code auto-discovers components in default locations and derives the plugin name from the directory name.

#### Complete Schema

```json
{
  "name": "plugin-name",
  "version": "1.2.0",
  "description": "Brief plugin description",
  "author": {
    "name": "Author Name",
    "email": "author@example.com",
    "url": "https://github.com/author"
  },
  "homepage": "https://docs.example.com/plugin",
  "repository": "https://github.com/author/plugin",
  "license": "MIT",
  "keywords": ["keyword1", "keyword2"],
  "commands": ["./custom/commands/special.md"],
  "agents": "./custom/agents/",
  "skills": "./custom/skills/",
  "hooks": "./config/hooks.json",
  "mcpServers": "./mcp-config.json",
  "outputStyles": "./styles/",
  "lspServers": "./.lsp.json"
}
```

#### Required Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `name` | string | Unique identifier (kebab-case, no spaces). Used for namespacing. | `"deployment-tools"` |

#### Metadata Fields

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Semantic version (`MAJOR.MINOR.PATCH`) |
| `description` | string | Brief explanation of plugin purpose |
| `author` | object | `{ name, email?, url? }` |
| `homepage` | string | Documentation URL |
| `repository` | string | Source code URL |
| `license` | string | License identifier (e.g., `"MIT"`, `"Apache-2.0"`) |
| `keywords` | array | Discovery tags |

#### Component Path Fields

| Field | Type | Description |
|-------|------|-------------|
| `commands` | string or array | Additional command files/directories |
| `agents` | string or array | Additional agent files |
| `skills` | string or array | Additional skill directories |
| `hooks` | string/array/object | Hook config paths or inline config |
| `mcpServers` | string/array/object | MCP config paths or inline config |
| `outputStyles` | string or array | Additional output style files/directories |
| `lspServers` | string/array/object | LSP server configurations |

Custom paths **supplement** default directories -- they do not replace them. All paths must be relative and start with `./`.

#### Environment Variables

`${CLAUDE_PLUGIN_ROOT}` contains the absolute path to the plugin directory at runtime. Use in hooks, MCP servers, and scripts:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/format-code.sh"
          }
        ]
      }
    ]
  }
}
```

---

## Part 3: Plugin Components in Detail

### 3.1 Skills

Skills are model-invoked capabilities that Claude uses autonomously based on task context.

**Location**: `skills/<skill-name>/SKILL.md`

```markdown
---
name: code-review
description: Reviews code for best practices. Use when reviewing code or PRs.
version: 1.0.0
disable-model-invocation: false
---

When reviewing code, check for:
1. Code organization and structure
2. Error handling
3. Security concerns
4. Test coverage
```

Skills support the `$ARGUMENTS` placeholder for dynamic user input. After plugin installation, skills are namespaced as `/plugin-name:skill-name`.

### 3.2 Commands

Commands are user-invoked slash commands defined as Markdown files.

**Location**: `commands/<command-name>.md`

```markdown
---
description: Short description for /help
argument-hint: <arg1> [optional-arg]
allowed-tools: [Read, Glob, Grep]
---

Instructions for Claude when this command is invoked.
```

Commands are namespaced as `/plugin-name:command-name`.

### 3.3 Agents

Custom subagents defined as Markdown files.

**Location**: `agents/<agent-name>.md`

```markdown
---
name: agent-name
description: What this agent specializes in
---

Detailed system prompt for the agent.
```

Agents appear in `/agents` and Claude can invoke them automatically based on context.

### 3.4 Hooks

Event handlers that respond to Claude Code lifecycle events.

**Location**: `hooks/hooks.json`

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/format-code.sh"
          }
        ]
      }
    ]
  }
}
```

#### Available Hook Events

| Event | Description |
|-------|-------------|
| `PreToolUse` | Before Claude uses any tool |
| `PostToolUse` | After Claude successfully uses a tool |
| `PostToolUseFailure` | After a tool execution fails |
| `PermissionRequest` | When a permission dialog is shown |
| `UserPromptSubmit` | When user submits a prompt |
| `Notification` | When Claude Code sends notifications |
| `Stop` | When Claude attempts to stop |
| `SubagentStart` | When a subagent is started |
| `SubagentStop` | When a subagent attempts to stop |
| `SessionStart` | At the beginning of sessions |
| `SessionEnd` | At the end of sessions |
| `TeammateIdle` | When an agent team teammate is about to go idle |
| `TaskCompleted` | When a task is being marked as completed |
| `PreCompact` | Before conversation history is compacted |

#### Hook Types

| Type | Description |
|------|-------------|
| `command` | Execute shell commands or scripts |
| `prompt` | Evaluate a prompt with an LLM (uses `$ARGUMENTS` placeholder) |
| `agent` | Run an agentic verifier with tools for complex verification |

### 3.5 MCP Servers

Bundled MCP server configurations for external tool integration.

**Location**: `.mcp.json` at plugin root

```json
{
  "mcpServers": {
    "plugin-database": {
      "command": "${CLAUDE_PLUGIN_ROOT}/servers/db-server",
      "args": ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json"],
      "env": {
        "DB_PATH": "${CLAUDE_PLUGIN_ROOT}/data"
      }
    }
  }
}
```

Plugin MCP servers start automatically when the plugin is enabled and integrate seamlessly with Claude's toolkit.

### 3.6 LSP Servers

Language Server Protocol configurations for real-time code intelligence.

**Location**: `.lsp.json` at plugin root

```json
{
  "go": {
    "command": "gopls",
    "args": ["serve"],
    "extensionToLanguage": {
      ".go": "go"
    }
  }
}
```

LSP provides instant diagnostics, code navigation, and type information. The language server binary must be installed separately.

### 3.7 Default Settings

Plugins can ship a `settings.json` to apply default configuration. Currently only the `agent` key is supported (activates a plugin agent as the main thread).

```json
{
  "agent": "security-reviewer"
}
```

---

## Part 4: Loading Plugins via the Agent SDK

### SDK Configuration Type

Both Python and TypeScript SDKs expose the same plugin configuration interface:

**TypeScript:**

```typescript
type SdkPluginConfig = {
  type: "local";
  path: string;
};
```

**Python:**

```python
class SdkPluginConfig(TypedDict):
    type: Literal["local"]
    path: str
```

Only `"local"` type plugins are currently supported. The `path` field accepts:
- **Relative paths**: Resolved relative to current working directory (e.g., `"./plugins/my-plugin"`)
- **Absolute paths**: Full filesystem paths (e.g., `"/home/user/plugins/my-plugin"`)

The path must point to the plugin root directory containing `.claude-plugin/plugin.json`.

### Loading Plugins in TypeScript

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Hello",
  options: {
    plugins: [
      { type: "local", path: "./my-plugin" },
      { type: "local", path: "/absolute/path/to/another-plugin" }
    ]
  }
})) {
  if (message.type === "system" && message.subtype === "init") {
    console.log("Loaded plugins:", message.plugins);
    // Example: [{ name: "my-plugin", path: "./my-plugin" }]
    console.log("Available commands:", message.slash_commands);
    // Example: ["/help", "/compact", "my-plugin:custom-command"]
  }

  if (message.type === "assistant") {
    console.log("Assistant:", message.content);
  }
}
```

### Loading Plugins in Python

```python
import asyncio
from claude_agent_sdk import query, ClaudeAgentOptions, AssistantMessage, TextBlock


async def main():
    options = ClaudeAgentOptions(
        plugins=[
            {"type": "local", "path": "./my-plugin"},
            {"type": "local", "path": "/absolute/path/to/another-plugin"},
        ],
        max_turns=3,
    )

    async for message in query(
        prompt="What custom commands do you have available?",
        options=options,
    ):
        if message.type == "system" and message.subtype == "init":
            print(f"Loaded plugins: {message.data.get('plugins')}")
            print(f"Available commands: {message.data.get('slash_commands')}")

        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    print(f"Assistant: {block.text}")


asyncio.run(main())
```

### How Plugins Are Passed to the CLI

The SDK's `SubprocessCLITransport` translates the `plugins` option into `--plugin-dir` CLI arguments when spawning the Claude Code subprocess. Each plugin path becomes a separate `--plugin-dir` flag:

```
claude --output-format stream-json --input-format stream-json \
  --plugin-dir ./my-plugin \
  --plugin-dir /absolute/path/to/another-plugin
```

### Verifying Plugin Installation

Plugin loading is confirmed in the `system` init message:

```typescript
// TypeScript: SDKSystemMessage includes:
type SDKSystemMessage = {
  type: "system";
  subtype: "init";
  session_id: string;
  // ...
  slash_commands: string[];
  skills: string[];
  plugins: { name: string; path: string }[];
};
```

### Using Plugin Commands

Plugin commands are namespaced with `plugin-name:command-name`:

```typescript
// TypeScript
for await (const message of query({
  prompt: "/my-plugin:greet",
  options: {
    plugins: [{ type: "local", path: "./my-plugin" }]
  }
})) {
  if (message.type === "assistant") {
    console.log(message.content);
  }
}
```

```python
# Python
async for message in query(
    prompt="/demo-plugin:greet",
    options={"plugins": [{"type": "local", "path": "./plugins/demo-plugin"}]},
):
    if isinstance(message, AssistantMessage):
        for block in message.content:
            if isinstance(block, TextBlock):
                print(f"Claude: {block.text}")
```

---

## Part 5: Plugin Lifecycle

### Loading Phase

1. **Path resolution**: SDK resolves relative paths against the current working directory
2. **CLI argument construction**: Each plugin path becomes a `--plugin-dir` argument
3. **Manifest discovery**: CLI scans each plugin directory for `.claude-plugin/plugin.json`
4. **Component discovery**: CLI discovers `commands/`, `agents/`, `skills/`, `hooks/`, `.mcp.json`, `.lsp.json`
5. **Namespacing**: All components are prefixed with the plugin name
6. **Init message**: Loaded plugins are reported in the `system` init message

### Runtime Phase

- **Skills**: Available for model-invoked or user-invoked use throughout the session
- **Commands**: Available via `/plugin-name:command-name` slash commands
- **Agents**: Appear in `/agents` and can be invoked by Claude or the user
- **Hooks**: Fire automatically on matching events (e.g., `PostToolUse` on `Write|Edit`)
- **MCP servers**: Start automatically and provide tools throughout the session
- **LSP servers**: Provide code intelligence for supported file types

### Caching (Marketplace Plugins Only)

For security, marketplace-installed plugins are copied to `~/.claude/plugins/cache/` rather than used in-place. Plugins loaded via `--plugin-dir` or the SDK `plugins` option are used directly from their specified path.

### Installation Scopes

| Scope | Settings File | Use Case |
|-------|--------------|----------|
| `user` | `~/.claude/settings.json` | Personal plugins, all projects (default) |
| `project` | `.claude/settings.json` | Team plugins, shared via version control |
| `local` | `.claude/settings.local.json` | Project-specific, gitignored |
| `managed` | Managed settings | Read-only, update only |

---

## Part 6: Built-in / Official Plugins

Anthropic maintains an official plugin marketplace at [github.com/anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) with 29 plugins as of this writing:

### Development Tools

| Plugin | Description |
|--------|-------------|
| `agent-sdk-dev` | SDK application scaffolding and verification |
| `plugin-dev` | Plugin development framework |
| `skill-creator` | Custom skill creation tools |
| `example-plugin` | Template/reference plugin |
| `playground` | Interactive testing environment |

### Code Quality

| Plugin | Description |
|--------|-------------|
| `code-review` | Code review assistance |
| `code-simplifier` | Code simplification and refactoring |
| `security-guidance` | Security best practices |
| `pr-review-toolkit` | Pull request review tools |

### Git / Workflow

| Plugin | Description |
|--------|-------------|
| `commit-commands` | Git commit automation |
| `feature-dev` | Feature development assistance |
| `claude-code-setup` | Setup and configuration |
| `claude-md-management` | Markdown file management |

### LSP (Language Server Protocol)

| Plugin | Language |
|--------|----------|
| `pyright-lsp` | Python |
| `typescript-lsp` | TypeScript |
| `rust-analyzer-lsp` | Rust |
| `gopls-lsp` | Go |
| `clangd-lsp` | C/C++ |
| `jdtls-lsp` | Java |
| `kotlin-lsp` | Kotlin |
| `swift-lsp` | Swift |
| `lua-lsp` | Lua |
| `php-lsp` | PHP |
| `csharp-lsp` | C# |

### Output Styles

| Plugin | Description |
|--------|-------------|
| `explanatory-output-style` | Detailed explanations |
| `learning-output-style` | Educational output |

### Specialized

| Plugin | Description |
|--------|-------------|
| `frontend-design` | Frontend design tools |
| `hookify` | React hooks utility |
| `ralph-loop` | Specialized workflow |

### Agent SDK Dev Plugin (Detailed)

The `agent-sdk-dev` plugin is notable as a comprehensive example. It includes:

- **Command**: `/new-sdk-app` -- interactive scaffolding for new Agent SDK projects
- **Agent**: `agent-sdk-verifier-py` -- verifies Python SDK applications
- **Agent**: `agent-sdk-verifier-ts` -- verifies TypeScript SDK applications

```
plugins/agent-sdk-dev/
├── .claude-plugin/
│   └── plugin.json
├── agents/
│   ├── agent-sdk-verifier-py.md
│   └── agent-sdk-verifier-ts.md
├── commands/
│   └── new-sdk-app.md
├── LICENSE
└── README.md
```

---

## Part 7: Creating Custom Plugins

### Minimal Plugin (Quickstart)

**Step 1**: Create the plugin directory and manifest:

```bash
mkdir -p my-plugin/.claude-plugin
```

```json
// my-plugin/.claude-plugin/plugin.json
{
  "name": "my-plugin",
  "description": "My custom plugin",
  "version": "1.0.0",
  "author": { "name": "Your Name" }
}
```

**Step 2**: Add a skill:

```bash
mkdir -p my-plugin/skills/hello
```

```markdown
<!-- my-plugin/skills/hello/SKILL.md -->
---
description: Greet the user with a personalized message
---

# Hello Skill

Greet the user named "$ARGUMENTS" warmly and ask how you can help them today.
```

**Step 3**: Test locally via CLI:

```bash
claude --plugin-dir ./my-plugin
```

Then use: `/my-plugin:hello Alex`

**Step 4**: Test via the Agent SDK:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import * as path from "path";

async function runWithPlugin() {
  const pluginPath = path.join(__dirname, "my-plugin");

  for await (const message of query({
    prompt: "/my-plugin:hello Alex",
    options: {
      plugins: [{ type: "local", path: pluginPath }],
      maxTurns: 3
    }
  })) {
    if (message.type === "system" && message.subtype === "init") {
      console.log("Loaded plugins:", message.plugins);
    }
    if (message.type === "assistant") {
      console.log("Assistant:", message.content);
    }
  }
}

runWithPlugin().catch(console.error);
```

### Plugin with Hooks

```json
// my-plugin/hooks/hooks.json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '.tool_input.file_path' | xargs npm run lint:fix"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo 'Plugin session started' >> /tmp/plugin.log"
          }
        ]
      }
    ]
  }
}
```

### Plugin with MCP Server

```json
// my-plugin/.mcp.json
{
  "mcpServers": {
    "plugin-database": {
      "command": "${CLAUDE_PLUGIN_ROOT}/servers/db-server",
      "args": ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json"],
      "env": {
        "DB_PATH": "${CLAUDE_PLUGIN_ROOT}/data"
      }
    }
  }
}
```

### Plugin with Agent

```markdown
<!-- my-plugin/agents/security-reviewer.md -->
---
name: security-reviewer
description: Reviews code for security vulnerabilities, injection attacks, and unsafe patterns
---

You are a security-focused code reviewer. When invoked, you should:

1. Scan for common vulnerability patterns (SQL injection, XSS, CSRF)
2. Check authentication and authorization logic
3. Review secrets handling and environment variable usage
4. Identify unsafe deserialization or eval usage
5. Report findings with severity levels
```

### Plugin with LSP Server

```json
// my-plugin/.lsp.json
{
  "go": {
    "command": "gopls",
    "args": ["serve"],
    "extensionToLanguage": {
      ".go": "go"
    }
  }
}
```

---

## Part 8: Python SDK vs TypeScript SDK Comparison

### Plugin Configuration

| Aspect | Python SDK | TypeScript SDK |
|--------|-----------|----------------|
| **Config type** | `SdkPluginConfig` (TypedDict) | `SdkPluginConfig` (type alias) |
| **Options field** | `ClaudeAgentOptions.plugins: list[SdkPluginConfig]` | `Options.plugins: SdkPluginConfig[]` |
| **Default** | `[]` (empty list) | `[]` (empty array) |
| **Plugin type** | `Literal["local"]` | `"local"` (string literal) |

### SDK Type Definitions

**Python:**

```python
class SdkPluginConfig(TypedDict):
    type: Literal["local"]
    path: str

@dataclass
class ClaudeAgentOptions:
    # ... other fields ...
    plugins: list[SdkPluginConfig] = field(default_factory=list)
```

**TypeScript:**

```typescript
type SdkPluginConfig = {
  type: "local";
  path: string;
};

interface Options {
  // ... other fields ...
  plugins?: SdkPluginConfig[];
}
```

### Init Message Plugin Data

**Python:**

```python
if message.type == "system" and message.subtype == "init":
    plugins = message.data.get("plugins")
    # Returns: [{"name": "my-plugin", "path": "./my-plugin"}]
    commands = message.data.get("slash_commands")
```

**TypeScript:**

```typescript
if (message.type === "system" && message.subtype === "init") {
  const plugins = message.plugins;
  // Returns: [{ name: "my-plugin", path: "./my-plugin" }]
  const commands = message.slash_commands;
}
```

### Complete Example Side-by-Side

**Python:**

```python
#!/usr/bin/env python3
from pathlib import Path
import anyio
from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    TextBlock,
    query,
)


async def run_with_plugin():
    plugin_path = Path(__file__).parent / "plugins" / "demo-plugin"

    options = ClaudeAgentOptions(
        plugins=[{"type": "local", "path": str(plugin_path)}],
        max_turns=3,
    )

    async for message in query(
        prompt="What custom commands do you have available?",
        options=options,
    ):
        if message.type == "system" and message.subtype == "init":
            print(f"Loaded plugins: {message.data.get('plugins')}")
            print(f"Available commands: {message.data.get('slash_commands')}")

        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    print(f"Assistant: {block.text}")


if __name__ == "__main__":
    anyio.run(run_with_plugin)
```

**TypeScript:**

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import * as path from "path";

async function runWithPlugin() {
  const pluginPath = path.join(__dirname, "plugins", "my-plugin");

  for await (const message of query({
    prompt: "What custom commands do you have available?",
    options: {
      plugins: [{ type: "local", path: pluginPath }],
      maxTurns: 3
    }
  })) {
    if (message.type === "system" && message.subtype === "init") {
      console.log("Loaded plugins:", message.plugins);
      console.log("Available commands:", message.slash_commands);
    }

    if (message.type === "assistant") {
      console.log("Assistant:", message.content);
    }
  }
}

runWithPlugin().catch(console.error);
```

### Key Differences

| Feature | Python SDK | TypeScript SDK |
|---------|-----------|----------------|
| **Init message access** | `message.data.get("plugins")` | `message.plugins` (direct property) |
| **Client types** | `query()` + `ClaudeSDKClient` | `query()` only (with `Query` object) |
| **Path construction** | `Path(__file__).parent / "plugins"` | `path.join(__dirname, "plugins")` |
| **Plugin data typing** | Accessed via generic `data` dict | Typed as `{ name: string; path: string }[]` |
| **API surface** | Identical plugin config shape | Identical plugin config shape |

---

## Part 9: Plugin Distribution and Marketplace

### Installation Methods

**CLI:**

```bash
# Install from marketplace
claude plugin install formatter@my-marketplace

# Install to specific scope
claude plugin install formatter@my-marketplace --scope project

# Load locally during development
claude --plugin-dir ./my-plugin

# Load multiple plugins
claude --plugin-dir ./plugin-one --plugin-dir ./plugin-two
```

**Interactive:**

```
/plugin install {plugin-name}@marketplace-name
/plugin > Discover  # Browse available plugins
```

### CLI Commands

| Command | Description |
|---------|-------------|
| `claude plugin install <plugin> [--scope]` | Install from marketplace |
| `claude plugin uninstall <plugin> [--scope]` | Remove installed plugin |
| `claude plugin enable <plugin> [--scope]` | Enable a disabled plugin |
| `claude plugin disable <plugin> [--scope]` | Disable without uninstalling |
| `claude plugin update <plugin> [--scope]` | Update to latest version |

### SDK-Installed Plugins

Plugins installed via CLI can also be used in the SDK by providing their cache path:

```typescript
// CLI-installed plugins are cached at ~/.claude/plugins/
plugins: [{ type: "local", path: "~/.claude/plugins/cache/my-plugin" }]
```

### Creating a Marketplace

Marketplaces are Git repositories containing a `marketplace.json` at the root and plugin directories. See [Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) for details.

---

## Part 10: Best Practices and Limitations

### Best Practices

1. **Start standalone, convert to plugin**: Begin with `.claude/` configuration for quick iteration, then package as a plugin when ready to share.

2. **Use semantic versioning**: Claude Code uses the version to determine whether to update. If you change code without bumping the version, existing users will not see changes.

3. **Use `${CLAUDE_PLUGIN_ROOT}`**: Always reference plugin-relative paths through this variable for portability across installations.

4. **Namespace awareness**: All plugin components are namespaced with `plugin-name:`. Choose short, descriptive plugin names.

5. **Test locally first**: Use `--plugin-dir` (CLI) or the `plugins` option (SDK) during development before publishing.

6. **Keep plugins self-contained**: Avoid referencing files outside the plugin directory. Path traversal outside the plugin root will not work after marketplace installation due to caching.

7. **Use symlinks for shared dependencies**: If external files are needed, symlink them into the plugin directory (symlinks are followed during cache copy).

8. **Make hook scripts executable**: `chmod +x scripts/your-script.sh` and include proper shebang lines.

### Limitations

1. **Only `"local"` plugin type supported**: There is no remote/URL-based plugin loading. All plugins must exist on the local filesystem.

2. **No programmatic plugin definition**: Unlike agents, hooks, and MCP servers which can be defined inline in SDK options, plugins must exist as filesystem directories with manifest files.

3. **No hot-reload**: Plugin changes require restarting the Claude Code session. Changes are not picked up at runtime.

4. **Namespace is mandatory**: Plugin skills/commands always get namespaced. You cannot use short names like `/hello` -- it will always be `/plugin-name:hello`.

5. **Marketplace plugins are cached**: Cached copies may be stale if the version number is not bumped.

6. **Path traversal restrictions**: Installed plugins cannot reference files outside their directory.

7. **LSP binary requirement**: LSP plugins do not bundle the language server binary. Users must install it separately.

8. **Settings scope limited**: Plugin `settings.json` only supports the `agent` key currently. Other settings keys are silently ignored.

9. **No plugin dependencies**: There is no mechanism for one plugin to depend on or require another plugin.

10. **No plugin API**: Plugins cannot expose programmatic APIs to other plugins or to the SDK consumer. They are purely configuration-based extensions.

### Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| Plugin not loading | Invalid `plugin.json` | Validate JSON syntax |
| Commands not appearing | Wrong directory structure | Ensure components at root, not in `.claude-plugin/` |
| Hooks not firing | Script not executable | `chmod +x script.sh` |
| MCP server fails | Missing `${CLAUDE_PLUGIN_ROOT}` | Use variable for all plugin paths |
| Path errors | Absolute paths in manifest | All paths must be relative, start with `./` |
| LSP not working | Binary not installed | Install the language server separately |

---

## Part 11: Architecture Summary

```
┌───────────────────────────────────────────────────────────────┐
│                      SDK Application                          │
│                                                               │
│  ClaudeAgentOptions / Options                                 │
│  ├── plugins: [{ type: "local", path: "./my-plugin" }]       │
│  ├── agents: { ... }          (inline agent definitions)      │
│  ├── hooks: { ... }           (inline hook callbacks)         │
│  ├── mcpServers: { ... }      (inline MCP configs)            │
│  └── allowedTools: [...]                                      │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  SubprocessCLITransport                                 │  │
│  │  Translates plugins → --plugin-dir CLI arguments        │  │
│  └─────────────────────────────────────────────────────────┘  │
│                          │                                    │
└──────────────────────────┼────────────────────────────────────┘
                           │ subprocess spawn
                           ▼
┌───────────────────────────────────────────────────────────────┐
│                    Claude Code CLI                             │
│                                                               │
│  --plugin-dir ./my-plugin                                     │
│  ├── Discovers .claude-plugin/plugin.json                     │
│  ├── Loads commands/, agents/, skills/                         │
│  ├── Loads hooks/hooks.json                                    │
│  ├── Starts .mcp.json servers                                  │
│  ├── Starts .lsp.json servers                                  │
│  ├── Namespaces all components                                 │
│  └── Reports in system init message                            │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐     │
│  │  Claude Code Agent Loop                              │     │
│  │  ├── Built-in tools (Read, Write, Edit, Bash, ...)   │     │
│  │  ├── Plugin skills (model-invoked)                   │     │
│  │  ├── Plugin agents (via Task tool)                   │     │
│  │  ├── Plugin MCP tools                                │     │
│  │  ├── Plugin hooks (fire on events)                   │     │
│  │  └── Plugin LSP (code intelligence)                  │     │
│  └──────────────────────────────────────────────────────┘     │
└───────────────────────────────────────────────────────────────┘
```

---

## References

- [Plugins in the SDK (Official Docs)](https://platform.claude.com/docs/en/agent-sdk/plugins)
- [Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [TypeScript SDK Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Python SDK Reference](https://platform.claude.com/docs/en/agent-sdk/python)
- [Create Plugins (Claude Code Docs)](https://code.claude.com/docs/en/plugins)
- [Plugins Reference (Claude Code Docs)](https://code.claude.com/docs/en/plugins-reference)
- [Official Plugin Marketplace (GitHub)](https://github.com/anthropics/claude-plugins-official)
- [Claude Agent SDK Python (GitHub)](https://github.com/anthropics/claude-agent-sdk-python)
- [Claude Agent SDK TypeScript (GitHub)](https://github.com/anthropics/claude-agent-sdk-typescript)
- [Claude Agent SDK Demos (GitHub)](https://github.com/anthropics/claude-agent-sdk-demos)
