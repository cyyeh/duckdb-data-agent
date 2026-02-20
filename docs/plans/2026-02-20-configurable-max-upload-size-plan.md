# Configurable Max Upload Size Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the max upload size configurable via a backend environment variable, exposed to the frontend via a `/api/config` endpoint, with server-side enforcement.

**Architecture:** Add `MAX_TOTAL_SIZE_BYTES` to backend `config.py` as an env var (default 500MB). Create a new `/api/config` GET endpoint. Frontend fetches this on init via a `ConfigContext` (same pattern as ThemeContext). Backend also enforces the limit in the upload endpoint.

**Tech Stack:** FastAPI (Python), React 18 + TypeScript, Context API

---

### Task 1: Add MAX_TOTAL_SIZE_BYTES to backend config

**Files:**
- Modify: `backend/app/config.py:14`
- Modify: `backend/.env.example:5`

**Step 1: Add env var to config.py**

Add after line 14 (`PROJECT_DIR = ...`):

```python
MAX_TOTAL_SIZE_BYTES = int(os.getenv("MAX_TOTAL_SIZE_BYTES", str(500 * 1024 * 1024)))  # default 500MB
```

**Step 2: Add to .env.example**

Add at the end:

```
MAX_TOTAL_SIZE_BYTES=524288000
```

**Step 3: Commit**

```bash
git add backend/app/config.py backend/.env.example
git commit -m "feat: add MAX_TOTAL_SIZE_BYTES env var to backend config"
```

---

### Task 2: Create /api/config endpoint

**Files:**
- Create: `backend/app/routes/config.py`
- Modify: `backend/app/main.py:8,23`

**Step 1: Create the config route**

Create `backend/app/routes/config.py`:

```python
from fastapi import APIRouter

from app.config import MAX_TOTAL_SIZE_BYTES

router = APIRouter(prefix="/api", tags=["config"])


@router.get("/config")
async def get_config():
    return {
        "maxTotalSizeBytes": MAX_TOTAL_SIZE_BYTES,
    }
```

**Step 2: Register the router in main.py**

In `backend/app/main.py`, update the import on line 8:

```python
from app.routes import tables, query, chat, langfuse_status, config
```

Add after line 23 (`app.include_router(langfuse_status.router)`):

```python
app.include_router(config.router)
```

**Step 3: Verify the endpoint works**

Run: `cd backend && poetry run uvicorn app.main:app --reload`
Test: `curl http://localhost:8000/api/config`
Expected: `{"maxTotalSizeBytes":524288000}`

**Step 4: Commit**

```bash
git add backend/app/routes/config.py backend/app/main.py
git commit -m "feat: add /api/config endpoint for max upload size"
```

---

### Task 3: Add server-side upload size enforcement

**Files:**
- Modify: `backend/app/routes/tables.py:3-4,24-30`

**Step 1: Add size check to upload endpoint**

In `backend/app/routes/tables.py`, add the import:

```python
from app.config import MAX_TOTAL_SIZE_BYTES
```

Update the `upload_csv` function to add size validation after reading content (after line 27):

```python
@router.post("/upload")
async def upload_csv(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Only CSV files are supported")
    content = await file.read()
    if len(content) > MAX_TOTAL_SIZE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File size exceeds the {MAX_TOTAL_SIZE_BYTES // (1024 * 1024)}MB limit"
        )
    table_name = sanitize_table_name(file.filename)
    result = db.load_csv(content, file.filename, table_name)
    return result
```

**Step 2: Commit**

```bash
git add backend/app/routes/tables.py
git commit -m "feat: add server-side upload size enforcement"
```

---

### Task 4: Create ConfigContext for frontend

**Files:**
- Create: `frontend/src/ConfigContext.tsx`

**Step 1: Create the context**

Create `frontend/src/ConfigContext.tsx`:

```typescript
import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';

interface ConfigContextValue {
  maxTotalSizeBytes: number;
}

const DEFAULT_MAX_TOTAL_SIZE_BYTES = 500 * 1024 * 1024; // 500MB

const ConfigContext = createContext<ConfigContextValue>({
  maxTotalSizeBytes: DEFAULT_MAX_TOTAL_SIZE_BYTES,
});

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [maxTotalSizeBytes, setMaxTotalSizeBytes] = useState(DEFAULT_MAX_TOTAL_SIZE_BYTES);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/config');
        if (res.ok) {
          const data = await res.json();
          if (typeof data.maxTotalSizeBytes === 'number') {
            setMaxTotalSizeBytes(data.maxTotalSizeBytes);
          }
        }
      } catch {
        // Config fetch is non-critical; use default
      }
    })();
  }, []);

  return (
    <ConfigContext.Provider value={{ maxTotalSizeBytes }}>
      {children}
    </ConfigContext.Provider>
  );
}

export function useConfig() {
  return useContext(ConfigContext);
}
```

**Step 2: Commit**

```bash
git add frontend/src/ConfigContext.tsx
git commit -m "feat: add ConfigContext for frontend config"
```

---

### Task 5: Wire up ConfigProvider and update FileUpload

**Files:**
- Modify: `frontend/src/App.tsx:3,306`
- Modify: `frontend/src/components/FileUpload.tsx:2,10,27-28,87`

**Step 1: Add ConfigProvider to App.tsx**

In `frontend/src/App.tsx`, add import:

```typescript
import { ConfigProvider } from './ConfigContext';
```

Wrap the return in the `App` component (around line 306) — add `ConfigProvider` as the outermost provider:

```typescript
  return (
    <ConfigProvider>
      <LanguageProvider>
        <ThemeProvider>
          <AgentProvider refreshTables={refreshTables}>
            <AppContent tables={tables} refreshTables={refreshTables} langfuseStatus={langfuseStatus} />
          </AgentProvider>
        </ThemeProvider>
      </LanguageProvider>
    </ConfigProvider>
  );
```

**Step 2: Update FileUpload.tsx to use config context**

In `frontend/src/components/FileUpload.tsx`:

Add import:

```typescript
import { useConfig } from '../ConfigContext';
```

Remove line 10:

```typescript
const MAX_TOTAL_SIZE_BYTES = 500 * 1024 * 1024; // 500MB
```

Inside the `FileUpload` component function, add at the top:

```typescript
const { maxTotalSizeBytes } = useConfig();
```

Replace all references to `MAX_TOTAL_SIZE_BYTES` with `maxTotalSizeBytes` (lines 27, 28, and 87).

**Step 3: Verify the frontend compiles**

Run: `cd frontend && npm run build`
Expected: Build succeeds with no errors.

**Step 4: Commit**

```bash
git add frontend/src/App.tsx frontend/src/components/FileUpload.tsx
git commit -m "feat: use ConfigContext for max upload size in frontend"
```

---

### Task 6: Manual end-to-end verification

**Step 1: Start backend and frontend**

```bash
cd backend && poetry run uvicorn app.main:app --reload &
cd frontend && npm run dev &
```

**Step 2: Verify config endpoint**

```bash
curl http://localhost:8000/api/config
```

Expected: `{"maxTotalSizeBytes":524288000}`

**Step 3: Verify frontend shows correct size**

Open the app in browser. The upload area should show "500MB" in the drop text.

**Step 4: Verify with custom env var**

Stop backend, restart with:

```bash
MAX_TOTAL_SIZE_BYTES=104857600 poetry run uvicorn app.main:app --reload
```

Verify: `curl http://localhost:8000/api/config` returns `{"maxTotalSizeBytes":104857600}` (100MB).
Refresh frontend — upload area should show "100MB".
