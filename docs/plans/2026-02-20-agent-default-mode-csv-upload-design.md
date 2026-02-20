# Agent Default Mode + CSV Upload in Agent Mode

## Summary

Make Agent Mode the default mode and allow CSV upload within Agent Mode when no tables exist.

## Changes

### 1. Default Mode: Agent Mode

In `App.tsx`, change `agentOpen` initial state from `false` to `true`:

```typescript
const [agentOpen, setAgentOpen] = useState(true);
```

### 2. FileUpload in AgentPanel

**New props on `AgentPanel`:**

```typescript
interface AgentPanelProps {
  langfuseStatus: LangfuseStatus;
  tables: TableInfo[];
  onUpload: (file: File) => Promise<void>;
  onLoadSample: () => Promise<void>;
}
```

**Conditional rendering in the message area:**

- `tables.length === 0` AND `messages.length === 0` → render `<FileUpload />`
- `tables.length > 0` AND `messages.length === 0` → render empty state text
- `messages.length > 0` → render messages (FileUpload hidden)

The FileUpload renders inside the existing `agent-panel__empty` container. Chat input remains visible at all times.

**App.tsx passes new props:**

```typescript
<AgentPanel
  langfuseStatus={langfuseStatus}
  tables={tables}
  onUpload={handleFileUpload}
  onLoadSample={handleLoadSample}
/>
```

### 3. Reactive Behavior

- Upload completes → `refreshTables()` runs → `tables` state updates → FileUpload disappears
- All tables deleted → `tables` becomes empty → FileUpload reappears (if no messages)
- No new i18n keys needed
- No backend changes needed

## Files Modified

- `frontend/src/App.tsx` — default state + prop passing
- `frontend/src/components/AgentPanel.tsx` — new props + conditional FileUpload rendering

## Verification

1. App starts in Agent Mode
2. No tables → FileUpload visible in message area
3. Upload CSV → FileUpload disappears, empty state text shows
4. Delete all tables via sidebar → FileUpload reappears
5. Chat input usable at all times
6. Editor Mode still works normally
