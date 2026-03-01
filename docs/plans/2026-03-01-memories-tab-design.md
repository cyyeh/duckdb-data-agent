# Memories Tab Design

## Summary

Add a "Memories" tab to the sidebar (right of Skills) that displays parsed agent memory entries grouped by category (Preferences, Facts, Patterns). Each entry has a trashcan icon for deletion. Clicking an entry opens a detail modal showing the entry, its category, and the full raw MEMORY.md for context. Full i18n support (en + zh-TW).

## Backend

New route file `backend/app/routes/memories.py`:

- `GET /api/memories` — parse `MEMORY.md` and return structured entries + raw content
  - Response: `{ entries: [{category, content}], raw: string }`
- `DELETE /api/memories` — remove a specific entry
  - Body: `{ content: string }`
  - Delegates to `agent_memory.forget_memory(content)`

Uses existing `agent_memory.py` functions. Register routes in `main.py`.

## Frontend

### MemoriesPanel component (`MemoriesPanel.tsx` + `MemoriesPanel.css`)

- Fetches from `GET /api/memories` on mount
- Groups entries by category with section headers
- Each entry: text + trashcan icon button (delete with confirmation)
- Click entry to open detail modal
- Empty state when no memories exist

### Detail modal

- Shows clicked entry text and category
- Below: full raw MEMORY.md rendered as markdown for context
- Close button (x) and overlay click to close
- Uses same portal pattern as `SkillsPanel` detail modal

### Sidebar changes

- `activeTab` type: `'tables' | 'skills' | 'memories'`
- Third tab button "Memories"
- Conditional rendering for `MemoriesPanel`

### Service layer

New `memoriesService.ts`:
- `fetchMemories()` — GET /api/memories
- `deleteMemory(content)` — DELETE /api/memories

## i18n

Add keys to both `en.json` and `zh-TW.json`:
- `memoriesTab`, `noMemories`, `deleteMemory`, `deleteMemoryConfirm`, `memoryCategory`, `memoryContext`, `memoryDeleted`, `preferencesCategory`, `factsCategory`, `patternsCategory`
