# Skills UI: Browse, Invoke, and Create Skills

**Date**: 2026-03-01
**Status**: Draft

## Problem

Skills are currently baked into the Docker image and invisible to users. Users cannot see what skills are available, invoke them explicitly, or create new ones. This limits discoverability and reusability of agent workflows.

## Goals

1. Users can browse available skills in the sidebar
2. Users can invoke a skill via slash command (`/skill-name`) in the chat input
3. Users can create new skills through conversation with the agent
4. Skills are stored dynamically on the host filesystem and volume-mounted into the sidecar

## Design

### Architecture: Backend API + Host Filesystem (Hybrid)

```
Frontend (React)                Backend (FastAPI)              Sidecar (Docker)

Skills Panel ──GET /api/skills──> reads .claude/skills/
  "Use" btn ──inserts /skill──>

Chat Input ──POST /api/chat───> passes skill ref ────────────> invokes Skill tool
  /skill-name                   to sidecar /query

Agent ──────────────────────────MCP create_skill──> writes
  "package as skill"            SKILL.md to disk    ──volume──> re-scanned per request
```

The backend manages CRUD via REST endpoints, reading/writing SKILL.md files on the host at `sidecar/.claude/skills/<name>/SKILL.md`. The same directory is volume-mounted into the sidecar container. The sidecar re-scans skills per request to discover dynamically added skills.

### Backend REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/skills` | List all skills (name + description, no body) |
| `GET` | `/api/skills/{name}` | Get full skill including content |
| `POST` | `/api/skills` | Create new skill |
| `PUT` | `/api/skills/{name}` | Update existing skill |
| `DELETE` | `/api/skills/{name}` | Delete a skill |

**Skill payload**:
```json
{
  "name": "analyze-data",
  "description": "Guides structured data analysis workflows using DuckDB",
  "content": "# Analyze Data\n\nStep-by-step workflow..."
}
```

**Validation**:
- `name`: matches `^[a-z0-9-]+$`, 1-64 characters
- `description`: non-empty, max 1024 characters
- `content`: non-empty markdown

**File operations**: Backend reads/writes SKILL.md with YAML frontmatter:
```yaml
---
name: analyze-data
description: Guides structured data analysis workflows using DuckDB
---

# Analyze Data
...
```

### New MCP tool: create_skill

Added to `mcp_sse.py` alongside `execute_sql`, `ask_user_question`, and `render_chart`:

```
create_skill(name: str, description: str, content: str) -> { success: bool, message: str }
```

This lets the agent create skills through the existing MCP SSE channel during a conversation. Same validation as the REST API. The sidecar's `allowedTools` list is updated to include `mcp__duckdb-data-agent__create_skill`.

### Frontend: Sidebar Skills Tab

The sidebar gains a tab bar at the top:

```
[Tables] [Skills]
```

**Skills tab contents**:
- Header: "Skills" title + "+" create button
- Skill list: each item shows name, truncated description, "Use" button, delete button
- Click skill name to expand full description
- "Use" button inserts `/skill-name` into chat input and focuses the textarea
- "+" button opens a minimal create dialog (name, description, content fields)
- Empty state: prompt to create a skill or use the chat

### Frontend: Slash Command Autocomplete

When the user types `/` as the first character in the chat input:

1. A dropdown popover appears above the textarea
2. Each item: skill name + one-line description
3. Arrow keys to navigate, Enter/click to select, Escape to dismiss
4. Further typing filters the list (e.g., `/ana` → "analyze-data")
5. Selecting inserts `/skill-name` into the input; user appends their question
6. On send, frontend detects `/skill-name` prefix and passes `{ skill: "skill-name" }` metadata to `/api/chat`

### Frontend: Skill Creation via Chat

When the agent calls the `create_skill` MCP tool:
1. Backend writes the SKILL.md file
2. The tool result SSE event signals success
3. Frontend detects the `create_skill` tool call and refreshes the skills list in the sidebar
4. User sees the new skill appear in the Skills tab

### Docker Changes

**docker-compose.yml**: Add writable volume mount:
```yaml
sidecar:
  volumes:
    - ./sidecar/.claude/skills:/app/.claude/skills
```

This overrides the `COPY .claude/ ./.claude/` from the Dockerfile for the skills subdirectory.

**Sidecar changes**:
- Move skill discovery from startup-only to per-request (re-scan `SKILLS_DIR` at each `/query` call)
- Update system prompt dynamically with current skill list per request
- Add `mcp__duckdb-data-agent__create_skill` to `allowedTools`
- Allowlist hook already derives from filesystem scan — no change needed

### i18n

New translation keys:
- `skillsTab`, `tablesTab`: sidebar tab labels
- `noSkills`: empty state message
- `createSkill`, `deleteSkill`, `useSkill`: action labels
- `skillCreated`, `skillDeleted`: confirmation messages
- `skillNameLabel`, `skillDescriptionLabel`, `skillContentLabel`: form labels

## Files Changed

### New files
1. **`backend/app/skills.py`** — Skill CRUD logic (read/write SKILL.md files)
2. **`backend/app/routes/skills.py`** — FastAPI router for `/api/skills` endpoints
3. **`frontend/src/components/SkillsPanel.tsx`** — Sidebar skills tab component
4. **`frontend/src/components/SkillsPanel.css`** — Styles
5. **`frontend/src/components/SlashCommandMenu.tsx`** — Autocomplete dropdown
6. **`frontend/src/components/SlashCommandMenu.css`** — Styles
7. **`frontend/src/components/CreateSkillDialog.tsx`** — Simple create form
8. **`frontend/src/components/CreateSkillDialog.css`** — Styles
9. **`frontend/src/services/skillsService.ts`** — API client for skills endpoints

### Modified files
1. **`backend/app/main.py`** — Register skills router
2. **`backend/app/mcp_sse.py`** — Add `create_skill` MCP tool
3. **`sidecar/src/server.ts`** — Per-request skill discovery, add create_skill to allowedTools
4. **`docker-compose.yml`** — Add skills volume mount
5. **`frontend/src/components/Sidebar.tsx`** — Add tab bar, render Skills or Tables based on active tab
6. **`frontend/src/components/Sidebar.css`** — Tab bar styles
7. **`frontend/src/components/ChatInput.tsx`** — Slash command detection, autocomplete trigger
8. **`frontend/src/components/ChatInput.css`** — Autocomplete positioning
9. **`frontend/src/contexts/AgentContext.tsx`** — Detect create_skill tool calls, emit refresh event
10. **`frontend/src/i18n/en.ts`** — New translation keys
11. **`frontend/src/i18n/zh.ts`** — New translation keys
12. **`frontend/src/types.ts`** — Add `SkillInfo` type
