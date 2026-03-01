# Sidecar Skill Setup Implementation Plan

**Status**: Implemented

**Goal:** Add a data analysis workflow skill to the sidecar so the Claude Agent SDK discovers and uses it automatically, with an allowlist hook to block built-in skills.

**Architecture:** Skill files live in `sidecar/.claude/skills/`, are COPY'd into the Docker image at `/app/.claude/skills/`, and the SDK loads them via `settingSources: ["project"]` with `"Skill"` in `allowedTools`. A `PreToolUse` hook dynamically discovers allowed skills from the `.claude/skills/` directory and blocks any built-in skills not in the allowlist.

**Tech Stack:** Claude Agent SDK (TypeScript), Docker, YAML frontmatter + Markdown

---

### Task 1: Create the skill file

**Files:**
- Create: `sidecar/.claude/skills/analyze-data/SKILL.md`

**Steps:**
1. `mkdir -p sidecar/.claude/skills/analyze-data`
2. Write `SKILL.md` with YAML frontmatter (`name: analyze-data`) and markdown body covering: data profiling, question clarification, analysis patterns, visualization guidance, DuckDB tips
3. Commit

---

### Task 2: Update sidecar .dockerignore

**Files:**
- Modify: `sidecar/.dockerignore`

**Steps:**
1. Add `!.claude/**` negation to re-include skill files despite `*.md` exclusion
2. Commit

---

### Task 3: Update sidecar Dockerfile

**Files:**
- Modify: `sidecar/Dockerfile`

**Steps:**
1. Add `COPY .claude/ ./.claude/` after `COPY --from=build /app/dist ./dist` in the production stage
2. Commit

---

### Task 4: Update sidecar server.ts to enable skills with allowlist

**Files:**
- Modify: `sidecar/src/server.ts`

**Steps:**

1. Import `SettingSource`, `HookCallbackMatcher`, `readdirSync` from SDK and fs
2. Add dynamic skill discovery at startup — scan `.claude/skills/` for subdirectories containing `SKILL.md`, build `ALLOWED_SKILLS` set
3. Add `PreToolUse` hook (`skillAllowlistHook`) that matches the `Skill` tool and denies any skill not in `ALLOWED_SKILLS`
4. In `baseOptions`, add:
   - `"Skill"` to `allowedTools`
   - `settingSources: ["project"] as SettingSource[]`
   - `plugins: []` (disable external plugin loading)
   - `hooks: { PreToolUse: [skillAllowlistHook] }`
5. Commit

---

### Task 5: Build and verify

**Steps:**
1. `docker build -t duckdb-agent-sidecar:test ./sidecar` — verify build succeeds
2. `docker run --rm duckdb-agent-sidecar:test cat /app/.claude/skills/analyze-data/SKILL.md` — verify skill file in image
3. `docker run --rm duckdb-agent-sidecar:test timeout 2 node dist/server.js` — verify startup log shows `[sidecar] Allowed skills: analyze-data`
