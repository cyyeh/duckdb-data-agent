# Agent Default Mode + CSV Upload Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Agent Mode the default landing mode and show CSV upload UI inside Agent Mode when no tables exist.

**Architecture:** Pass table state and upload handlers from App.tsx into AgentPanel as props. AgentPanel conditionally renders FileUpload in its empty message area based on `tables.length === 0`. One-line default state change makes Agent Mode load first.

**Tech Stack:** React, TypeScript

---

### Task 1: Set Agent Mode as Default

**Files:**
- Modify: `frontend/src/App.tsx:24`

**Step 1: Change default state**

Change line 24 from:
```typescript
const [agentOpen, setAgentOpen] = useState(false);
```
to:
```typescript
const [agentOpen, setAgentOpen] = useState(true);
```

**Step 2: Verify**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent/frontend && npm run build`
Expected: Build succeeds with no errors.

**Step 3: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat: set agent mode as default landing mode"
```

---

### Task 2: Add FileUpload to AgentPanel

**Files:**
- Modify: `frontend/src/components/AgentPanel.tsx`
- Modify: `frontend/src/App.tsx:175`

**Step 1: Update AgentPanel props and imports**

In `frontend/src/components/AgentPanel.tsx`, add the FileUpload import and extend the props interface:

```typescript
import { FileUpload } from './FileUpload';
import type { LangfuseStatus, TableInfo } from '../types';

interface AgentPanelProps {
  langfuseStatus: LangfuseStatus;
  tables: TableInfo[];
  onUpload: (file: File) => Promise<void>;
  onLoadSample: () => Promise<void>;
}
```

**Step 2: Destructure new props and update empty state rendering**

Update the component function signature to destructure the new props:

```typescript
export function AgentPanel({ langfuseStatus, tables, onUpload, onLoadSample }: AgentPanelProps) {
```

Replace the empty state block (the `{messages.length === 0 && ...}` section) with:

```typescript
{messages.length === 0 && (
  <div className="agent-panel__empty">
    {tables.length === 0 ? (
      <FileUpload onUpload={onUpload} onLoadSample={onLoadSample} />
    ) : (
      t('agentEmptyState')
    )}
  </div>
)}
```

**Step 3: Pass new props from App.tsx**

In `frontend/src/App.tsx`, update the AgentPanel usage (line 175) from:

```typescript
<AgentPanel langfuseStatus={langfuseStatus} />
```

to:

```typescript
<AgentPanel
  langfuseStatus={langfuseStatus}
  tables={tables}
  onUpload={handleFileUpload}
  onLoadSample={handleLoadSample}
/>
```

**Step 4: Verify build**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent/frontend && npm run build`
Expected: Build succeeds with no TypeScript errors.

**Step 5: Manual verification checklist**

Run: `cd /Users/cyyeh/Desktop/duckdb-data-agent && make dev` (or however the dev server starts)

Verify:
- [ ] App opens in Agent Mode by default
- [ ] With no tables: FileUpload (drag-drop + sample button) visible in message area
- [ ] Chat input visible below the upload area
- [ ] Upload a CSV → FileUpload disappears, empty state text shows
- [ ] Delete all tables via sidebar → FileUpload reappears
- [ ] Switch to Editor Mode → Editor's FileUpload still works independently
- [ ] Switch back to Agent Mode → correct state based on table count

**Step 6: Commit**

```bash
git add frontend/src/components/AgentPanel.tsx frontend/src/App.tsx
git commit -m "feat: show CSV upload in agent mode when no tables exist"
```
