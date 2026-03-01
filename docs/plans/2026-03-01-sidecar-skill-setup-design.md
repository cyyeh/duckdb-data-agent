# Sidecar Skill Setup: Data Analysis Workflow

**Date**: 2026-03-01
**Status**: Implemented

## Problem

The sidecar (Claude Agent SDK in Docker) has no skills configured. Adding a data analysis workflow skill will guide the agent through structured analysis steps, improving response quality for business analyst users.

## Design

### Approach: Static skills baked into Docker image

Skills are defined as `sidecar/.claude/skills/<name>/SKILL.md` files and copied into the Docker image at build time. The SDK discovers them via `settingSources: ["project"]`.

**Why not runtime/dynamic skills?** The sidecar container runs `read_only=True` with tmpfs at `/home/appuser`. Writing to `/app/.claude/skills/` is not possible at runtime. Dynamic skill creation is a future enhancement requiring a persistent Docker volume.

### Architecture

```
Repository (sidecar/)                Docker Image (/app)
.claude/skills/                      .claude/skills/
  analyze-data/                        analyze-data/
    SKILL.md          --COPY-->          SKILL.md

SDK options:
  settingSources: ["project"]    // loads .claude/skills/ from cwd (/app)
  allowedTools: [..., "Skill"]   // enables Skill tool invocation
  plugins: []                    // disables external plugin loading
  hooks:
    PreToolUse: skillAllowlistHook  // blocks built-in skills not in .claude/skills/
```

### Built-in skill filtering

The Claude Code binary bundled with `@anthropic-ai/claude-agent-sdk` includes built-in skills (e.g. "simplify") that load regardless of `settingSources` or `plugins` settings. To ensure only project-provided skills are usable:

- At startup, the sidecar scans `.claude/skills/` for subdirectories containing `SKILL.md`
- A `PreToolUse` hook on the `Skill` tool checks if the requested skill name is in the discovered allowlist
- Skills not in the allowlist are denied with a reason message
- New skills are automatically allowed by adding a `<name>/SKILL.md` to `sidecar/.claude/skills/`

### Files changed

1. **New: `sidecar/.claude/skills/analyze-data/SKILL.md`**
   - Hybrid-rigidity skill for business analysts
   - Required: data profiling first step
   - Flexible: analysis and visualization steps adapt to context
   - DuckDB-specific: references MCP tools (`execute_sql`, `render_chart`, `ask_user_question`)

2. **Edit: `sidecar/.dockerignore`**
   - Added `!.claude/**` exception so SKILL.md files are included in build context

3. **Edit: `sidecar/Dockerfile`**
   - Added `COPY .claude/ ./.claude/` in production stage

4. **Edit: `sidecar/src/server.ts`**
   - Imported `SettingSource`, `HookCallbackMatcher` from SDK
   - Added `settingSources: ["project"]` to SDK query options
   - Added `"Skill"` to `allowedTools` array
   - Added `plugins: []` to disable external plugin loading
   - Added dynamic skill discovery from `.claude/skills/` at startup
   - Added `PreToolUse` hook to allowlist only discovered skills

### Skill design: analyze-data

**Target audience**: Business analysts
**Rigidity**: Hybrid (required first step, flexible subsequent steps)

**Workflow**:
1. **Profile data** (required) — schema, row counts, samples, null rates via `execute_sql`
2. **Understand the question** — clarify via `ask_user_question` if ambiguous
3. **Analyze** (flexible) — aggregations, trends, comparisons, distributions
4. **Visualize** (flexible) — appropriate chart type via `render_chart`
5. **Summarize** — key findings in plain language

**DuckDB hints**: Date functions, window functions, `SAMPLE` for large tables, `DESCRIBE` for schema inspection.

### Future: Dynamic skill creation

When needed, the path to dynamic skills:
1. Replace tmpfs at `/home/appuser` with a persistent Docker volume
2. Add `"user"` to `settingSources: ["user", "project"]`
3. Add an API endpoint for creating/managing skills at `~/.claude/skills/`
4. Each new `query()` call discovers the latest skills automatically
