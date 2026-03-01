# Memories Tab Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "Memories" tab to the sidebar that lists agent memory entries grouped by category, with delete functionality and a detail modal showing entry context.

**Architecture:** New backend API route (`/api/memories`) wrapping existing `agent_memory.py`. New `MemoriesPanel` React component following the `SkillsPanel` pattern. Three-tab sidebar (Tables | Skills | Memories). Full i18n.

**Tech Stack:** FastAPI (backend), React + TypeScript (frontend), existing CSS variable system

---

### Task 1: Backend — Add memories API route

**Files:**
- Create: `backend/app/routes/memories.py`
- Modify: `backend/app/main.py:11,69`

**Step 1: Create the route file**

Create `backend/app/routes/memories.py`:

```python
import re

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.agent_memory import read_memories, forget_memory

router = APIRouter(prefix="/api", tags=["memories"])


class DeleteMemoryRequest(BaseModel):
    content: str


@router.get("/memories")
async def api_list_memories():
    raw = read_memories(user_id="default")
    entries = []
    current_category = "fact"
    category_map = {
        "## Preferences": "preference",
        "## Facts": "fact",
        "## Patterns": "pattern",
    }
    for line in raw.split("\n"):
        stripped = line.strip()
        if stripped in category_map:
            current_category = category_map[stripped]
        elif stripped.startswith("- "):
            entries.append({
                "category": current_category,
                "content": stripped[2:],
            })
    return {"entries": entries, "raw": raw}


@router.delete("/memories")
async def api_delete_memory(request: DeleteMemoryRequest):
    result = forget_memory(request.content, user_id="default")
    if result == "Memory not found.":
        return JSONResponse(status_code=404, content={"error": result})
    return {"status": "deleted"}
```

**Step 2: Register the route in main.py**

In `backend/app/main.py`, add `memories` to the import at line 11:

```python
from app.routes import tables, query, chat, langfuse_status, config, session, skills, conversations, memories
```

Add after line 69 (`app.include_router(conversations.router)`):

```python
app.include_router(memories.router)
```

**Step 3: Verify the backend starts**

Run: `cd backend && python -c "from app.routes.memories import router; print('OK')"`
Expected: `OK`

**Step 4: Commit**

```bash
git add backend/app/routes/memories.py backend/app/main.py
git commit -m "feat: add GET/DELETE /api/memories backend routes"
```

---

### Task 2: Frontend — Add memories service layer

**Files:**
- Create: `frontend/src/services/memoriesService.ts`

**Step 1: Create the service file**

Create `frontend/src/services/memoriesService.ts`:

```typescript
export interface MemoryEntry {
  category: 'preference' | 'fact' | 'pattern';
  content: string;
}

export interface MemoriesResponse {
  entries: MemoryEntry[];
  raw: string;
}

export async function fetchMemories(): Promise<MemoriesResponse> {
  const resp = await fetch('/api/memories');
  if (!resp.ok) throw new Error('Failed to fetch memories');
  return resp.json();
}

export async function deleteMemory(content: string): Promise<void> {
  const resp = await fetch('/api/memories', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error || 'Failed to delete memory');
  }
}
```

**Step 2: Commit**

```bash
git add frontend/src/services/memoriesService.ts
git commit -m "feat: add memoriesService frontend API layer"
```

---

### Task 3: Frontend — Add i18n keys

**Files:**
- Modify: `frontend/src/i18n/en.json`
- Modify: `frontend/src/i18n/zh-TW.json`

**Step 1: Add English translations**

Add these keys to `frontend/src/i18n/en.json` (before the closing `}`):

```json
"memoriesTab": "Memories",
"noMemories": "No memories yet. The agent saves preferences, facts, and patterns as it learns from conversations.",
"deleteMemory": "Delete memory",
"deleteMemoryConfirm": "Delete this memory?",
"memoryDeleted": "Memory deleted.",
"preferencesCategory": "Preferences",
"factsCategory": "Facts",
"patternsCategory": "Patterns",
"memoryContext": "Full Memory File"
```

**Step 2: Add Chinese (Traditional) translations**

Add these keys to `frontend/src/i18n/zh-TW.json` (before the closing `}`):

```json
"memoriesTab": "記憶",
"noMemories": "尚無記憶。代理會在對話中學習並儲存偏好、事實和模式。",
"deleteMemory": "刪除記憶",
"deleteMemoryConfirm": "確定刪除此記憶？",
"memoryDeleted": "記憶已刪除。",
"preferencesCategory": "偏好",
"factsCategory": "事實",
"patternsCategory": "模式",
"memoryContext": "完整記憶檔案"
```

**Step 3: Commit**

```bash
git add frontend/src/i18n/en.json frontend/src/i18n/zh-TW.json
git commit -m "i18n: add memories tab translations (en + zh-TW)"
```

---

### Task 4: Frontend — Create MemoriesPanel component

**Files:**
- Create: `frontend/src/components/MemoriesPanel.tsx`
- Create: `frontend/src/components/MemoriesPanel.css`

**Step 1: Create the CSS file**

Create `frontend/src/components/MemoriesPanel.css`:

```css
.memories-panel {
  padding: 0;
}

.memories-panel__empty {
  font-size: 13px;
  color: var(--color-text-faint);
  padding: 0;
  margin: 0;
}

.memories-panel__section {
  margin-bottom: 12px;
}

.memories-panel__section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--color-text-muted);
  margin: 0 0 6px;
  padding: 0;
}

.memories-panel__list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.memories-panel__item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid var(--color-border-light);
  margin-bottom: 4px;
  cursor: pointer;
}

.memories-panel__item:hover {
  border-color: var(--color-border-medium);
}

.memories-panel__text {
  flex: 1;
  font-size: 13px;
  color: var(--color-text-primary);
  line-height: 1.4;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.memories-panel__delete-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-text-muted);
  padding: 0 2px;
  flex-shrink: 0;
  opacity: 1;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}

.memories-panel__delete-btn:hover {
  color: var(--color-error);
}

/* Detail modal */

.memory-detail-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.memory-detail-modal {
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-medium);
  border-radius: 12px;
  padding: 24px;
  width: 560px;
  max-width: 90vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}

.memory-detail-modal__header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.memory-detail-modal__category {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--color-accent-primary);
}

.memory-detail-modal__close {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 20px;
  color: var(--color-text-muted);
  padding: 0 4px;
  line-height: 1;
  margin-left: auto;
}

.memory-detail-modal__close:hover {
  color: var(--color-text-primary);
}

.memory-detail-modal__entry {
  font-size: 14px;
  color: var(--color-text-primary);
  line-height: 1.5;
  margin: 0 0 16px;
}

.memory-detail-modal__context-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--color-text-muted);
  margin: 0 0 8px;
}

.memory-detail-modal__context {
  font-size: 12px;
  font-family: monospace;
  color: var(--color-text-secondary);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border-light);
  border-radius: 6px;
  padding: 12px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

/* Mobile touch targets */
@media (pointer: coarse) {
  .memories-panel__delete-btn {
    min-width: 36px;
    min-height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
}
```

**Step 2: Create the component file**

Create `frontend/src/components/MemoriesPanel.tsx`:

```tsx
import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '../hooks/useTranslation';
import { fetchMemories, deleteMemory as apiDeleteMemory } from '../services/memoriesService';
import type { MemoryEntry } from '../services/memoriesService';
import './MemoriesPanel.css';

interface MemoriesPanelProps {
  refreshKey: number;
}

const CATEGORY_ORDER: MemoryEntry['category'][] = ['preference', 'fact', 'pattern'];

const CATEGORY_I18N: Record<MemoryEntry['category'], string> = {
  preference: 'preferencesCategory',
  fact: 'factsCategory',
  pattern: 'patternsCategory',
};

export function MemoriesPanel({ refreshKey }: MemoriesPanelProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [raw, setRaw] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<MemoryEntry | null>(null);

  const loadMemories = useCallback(async () => {
    try {
      const data = await fetchMemories();
      setEntries(data.entries);
      setRaw(data.raw);
    } catch {
      // silently ignore
    }
  }, []);

  useEffect(() => { loadMemories(); }, [loadMemories, refreshKey]);

  const handleDelete = async (content: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(t('deleteMemoryConfirm'))) return;
    try {
      await apiDeleteMemory(content);
      setEntries((prev) => {
        const idx = prev.findIndex((m) => m.content === content);
        if (idx === -1) return prev;
        return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
      });
      if (selectedEntry?.content === content) setSelectedEntry(null);
    } catch {
      // silently ignore
    }
  };

  const grouped = CATEGORY_ORDER
    .map((cat) => ({ category: cat, items: entries.filter((e) => e.category === cat) }))
    .filter((g) => g.items.length > 0);

  if (entries.length === 0) {
    return (
      <div className="memories-panel">
        <p className="memories-panel__empty">{t('noMemories')}</p>
      </div>
    );
  }

  return (
    <div className="memories-panel">
      {grouped.map((group) => (
        <div key={group.category} className="memories-panel__section">
          <h3 className="memories-panel__section-title">{t(CATEGORY_I18N[group.category])}</h3>
          <ul className="memories-panel__list">
            {group.items.map((entry, idx) => (
              <li key={`${group.category}-${idx}`} className="memories-panel__item" onClick={() => setSelectedEntry(entry)}>
                <span className="memories-panel__text">{entry.content}</span>
                <button
                  className="memories-panel__delete-btn"
                  onClick={(e) => handleDelete(entry.content, e)}
                  title={t('deleteMemory')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {selectedEntry && createPortal(
        <div className="memory-detail-overlay" onClick={() => setSelectedEntry(null)}>
          <div className="memory-detail-modal" onClick={(e) => e.stopPropagation()}>
            <div className="memory-detail-modal__header">
              <span className="memory-detail-modal__category">{t(CATEGORY_I18N[selectedEntry.category])}</span>
              <button className="memory-detail-modal__close" onClick={() => setSelectedEntry(null)}>
                &times;
              </button>
            </div>
            <p className="memory-detail-modal__entry">{selectedEntry.content}</p>
            <p className="memory-detail-modal__context-label">{t('memoryContext')}</p>
            <pre className="memory-detail-modal__context">{raw}</pre>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
```

**Step 3: Commit**

```bash
git add frontend/src/components/MemoriesPanel.tsx frontend/src/components/MemoriesPanel.css
git commit -m "feat: add MemoriesPanel component with detail modal"
```

---

### Task 5: Frontend — Wire MemoriesPanel into Sidebar

**Files:**
- Modify: `frontend/src/components/Sidebar.tsx:1-7,30,53-65,76-168`

**Step 1: Update Sidebar imports and state**

In `frontend/src/components/Sidebar.tsx`:

Add import at line 4 (after SkillsPanel import):
```typescript
import { MemoriesPanel } from './MemoriesPanel';
```

Change line 30 from:
```typescript
const [activeTab, setActiveTab] = useState<'tables' | 'skills'>('tables');
```
to:
```typescript
const [activeTab, setActiveTab] = useState<'tables' | 'skills' | 'memories'>('tables');
```

Add after line 32 (`const [skillsRefreshKey, ...`):
```typescript
const [memoriesRefreshKey, setMemoriesRefreshKey] = useState(0);
```

**Step 2: Add the Memories tab button**

After the Skills tab button (after line 65 `</button>`), add:
```tsx
<button
  className={`sidebar__tab ${activeTab === 'memories' ? 'sidebar__tab--active' : ''}`}
  onClick={() => setActiveTab('memories')}
>
  {t('memoriesTab')}
</button>
```

**Step 3: Update conditional rendering**

Replace the conditional rendering block (lines 77-168, the `{activeTab === 'tables' ? (...) : (...)}` section) with a three-way conditional:

```tsx
{activeTab === 'tables' ? (
  <>{/* existing tables content — unchanged */}</>
) : activeTab === 'skills' ? (
  <SkillsPanel
    onUseSkill={onUseSkill ?? (() => {})}
    onCreateClick={() => setShowCreateDialog(true)}
    refreshKey={skillsRefreshKey}
  />
) : (
  <MemoriesPanel refreshKey={memoriesRefreshKey} />
)}
```

**Step 4: Verify the app compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add frontend/src/components/Sidebar.tsx
git commit -m "feat: wire MemoriesPanel as third sidebar tab"
```

---

### Task 6: Manual smoke test

**Step 1: Start the backend and frontend**

Verify:
1. Three tabs visible in sidebar: Tables | Skills | Memories
2. Memories tab shows empty state when no memories exist
3. If memories exist, they appear grouped by category
4. Clicking a memory opens the detail modal with entry + raw context
5. Trashcan icon deletes after confirmation
6. Switch language — all strings translate correctly

**Step 2: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address smoke test issues for memories tab"
```
