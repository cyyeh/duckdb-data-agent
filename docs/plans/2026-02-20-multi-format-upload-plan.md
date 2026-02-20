# Multi-Format File Upload Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow users to upload CSV, JSON, Parquet, and Excel files into DuckDB, with combined total size enforcement and multi-file support.

**Architecture:** Extend the existing single-format upload pipeline. DuckDB reads CSV/JSON/Parquet natively via `read_csv_auto`, `read_json_auto`, `read_parquet`. Excel files are converted per-sheet to CSV via openpyxl, then loaded through the existing CSV path. The backend keeps the one-file-per-request pattern (frontend already loops). Excel uploads return a list of tables (one per sheet).

**Tech Stack:** DuckDB (native readers), openpyxl (Excel), FastAPI, React + TypeScript

---

### Task 1: Add openpyxl dependency

**Files:**
- Modify: `backend/pyproject.toml:9-18`

**Step 1: Add the dependency**

Add `openpyxl` to `[tool.poetry.dependencies]` in `backend/pyproject.toml`:

```toml
[tool.poetry.dependencies]
python = "^3.12"
fastapi = "^0.129.0"
uvicorn = {extras = ["standard"], version = "^0.41.0"}
duckdb = "^1.4.4"
python-dotenv = "^1.2.1"
python-multipart = "^0.0.22"
claude-agent-sdk = "^0.1.38"
langfuse = "^3.0.0"
langsmith = {extras = ["claude-agent-sdk", "otel"], version = ">=0.3.0"}
openpyxl = "^3.1.0"
```

**Step 2: Install the dependency**

Run: `cd backend && poetry lock --no-update && poetry install`
Expected: openpyxl installed successfully

**Step 3: Commit**

```bash
git add backend/pyproject.toml backend/poetry.lock
git commit -m "chore: add openpyxl dependency for Excel file support"
```

---

### Task 2: Update sanitize_table_name for all formats

**Files:**
- Modify: `backend/app/routes/tables.py:11-16`

**Step 1: Update sanitize_table_name to strip all supported extensions**

Replace the current function in `backend/app/routes/tables.py`:

```python
def sanitize_table_name(filename: str) -> str:
    base = re.sub(r"\.(csv|json|parquet|xlsx|xls)$", "", filename, flags=re.IGNORECASE)
    sanitized = re.sub(r"[^a-z0-9_]", "_", base.lower())
    sanitized = re.sub(r"^[^a-z]", lambda m: "t_" + m.group(), sanitized)
    sanitized = re.sub(r"_+", "_", sanitized).rstrip("_")
    return sanitized or "table"
```

The only change is the regex: `\.csv$` becomes `\.(csv|json|parquet|xlsx|xls)$`.

**Step 2: Commit**

```bash
git add backend/app/routes/tables.py
git commit -m "refactor: update sanitize_table_name for all supported file extensions"
```

---

### Task 3: Add load_json and load_parquet methods to Database

**Files:**
- Modify: `backend/app/database.py:20-31`

**Step 1: Add load_json method**

Add after the existing `load_csv` method in `backend/app/database.py`:

```python
def load_json(self, file_bytes: bytes, filename: str, table_name: str) -> dict[str, Any]:
    """Load a JSON file (array of objects) into a DuckDB table. Returns table info."""
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tmp:
        tmp.write(file_bytes)
        tmp_path = tmp.name
    try:
        self.conn.execute(
            f'CREATE OR REPLACE TABLE "{table_name}" AS SELECT * FROM read_json_auto(\'{tmp_path}\')'
        )
    finally:
        os.unlink(tmp_path)
    return self.get_table_info(table_name)

def load_parquet(self, file_bytes: bytes, filename: str, table_name: str) -> dict[str, Any]:
    """Load a Parquet file into a DuckDB table. Returns table info."""
    with tempfile.NamedTemporaryFile(suffix=".parquet", delete=False) as tmp:
        tmp.write(file_bytes)
        tmp_path = tmp.name
    try:
        self.conn.execute(
            f'CREATE OR REPLACE TABLE "{table_name}" AS SELECT * FROM read_parquet(\'{tmp_path}\')'
        )
    finally:
        os.unlink(tmp_path)
    return self.get_table_info(table_name)
```

**Step 2: Commit**

```bash
git add backend/app/database.py
git commit -m "feat: add load_json and load_parquet methods to Database"
```

---

### Task 4: Add load_excel method to Database

**Files:**
- Modify: `backend/app/database.py`

**Step 1: Add load_excel method**

Add after `load_parquet` in `backend/app/database.py`. Also add `import csv` and `import re` at the top of the file.

New imports at top of file:

```python
import csv
import re
```

New method:

```python
def load_excel(self, file_bytes: bytes, filename: str, base_table_name: str) -> list[dict[str, Any]]:
    """Load an Excel file into DuckDB tables (one per sheet). Returns list of table infos."""
    import openpyxl

    with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as tmp:
        tmp.write(file_bytes)
        tmp_path = tmp.name
    try:
        wb = openpyxl.load_workbook(tmp_path, read_only=True, data_only=True)
        sheet_names = wb.sheetnames
        results = []
        for sheet_name in sheet_names:
            ws = wb[sheet_name]
            rows = list(ws.iter_rows(values_only=True))
            if not rows:
                continue
            # Sanitize sheet name for table name
            sanitized_sheet = re.sub(r"[^a-z0-9_]", "_", sheet_name.lower())
            sanitized_sheet = re.sub(r"_+", "_", sanitized_sheet).strip("_")
            table_name = f"{base_table_name}_{sanitized_sheet}" if len(sheet_names) > 1 else base_table_name
            # Write sheet data to temp CSV
            with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False, newline="") as csv_tmp:
                writer = csv.writer(csv_tmp)
                for row in rows:
                    writer.writerow(row)
                csv_tmp_path = csv_tmp.name
            try:
                self.conn.execute(
                    f'CREATE OR REPLACE TABLE "{table_name}" AS SELECT * FROM read_csv_auto(\'{csv_tmp_path}\')'
                )
                results.append(self.get_table_info(table_name))
            finally:
                os.unlink(csv_tmp_path)
        wb.close()
        return results
    finally:
        os.unlink(tmp_path)
```

**Step 2: Commit**

```bash
git add backend/app/database.py
git commit -m "feat: add load_excel method to Database using openpyxl"
```

---

### Task 5: Add load_file dispatcher to Database

**Files:**
- Modify: `backend/app/database.py`

**Step 1: Add load_file method**

Add after `load_excel` in `backend/app/database.py`:

```python
SUPPORTED_EXTENSIONS = {".csv", ".json", ".parquet", ".xlsx", ".xls"}

def load_file(self, file_bytes: bytes, filename: str, table_name: str) -> list[dict[str, Any]]:
    """Dispatch file loading based on extension. Returns list of table infos."""
    ext = os.path.splitext(filename)[1].lower()
    if ext == ".csv":
        return [self.load_csv(file_bytes, filename, table_name)]
    elif ext == ".json":
        return [self.load_json(file_bytes, filename, table_name)]
    elif ext == ".parquet":
        return [self.load_parquet(file_bytes, filename, table_name)]
    elif ext in (".xlsx", ".xls"):
        return self.load_excel(file_bytes, filename, table_name)
    else:
        raise ValueError(f"Unsupported file format: {ext}")
```

Note: `SUPPORTED_EXTENSIONS` is defined as a module-level constant (outside the class) so it can be imported by the routes module.

**Step 2: Commit**

```bash
git add backend/app/database.py
git commit -m "feat: add load_file dispatcher to Database"
```

---

### Task 6: Update upload route for multi-format support

**Files:**
- Modify: `backend/app/routes/tables.py`

**Step 1: Update the upload endpoint**

Replace the `upload_csv` function in `backend/app/routes/tables.py`:

```python
import os

from app.database import db, SUPPORTED_EXTENSIONS

@router.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file format. Supported: {', '.join(sorted(SUPPORTED_EXTENSIONS))}"
        )
    content = await file.read()
    if len(content) > MAX_TOTAL_SIZE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File size exceeds the {MAX_TOTAL_SIZE_BYTES // (1024 * 1024)}MB limit"
        )
    table_name = sanitize_table_name(file.filename)
    results = db.load_file(content, file.filename, table_name)
    # Return single table info for non-Excel, list for Excel (backward compatible)
    if len(results) == 1:
        return results[0]
    return results
```

Also update the `import` line at the top:

```python
import os
import re

from fastapi import APIRouter, UploadFile, File, HTTPException

from app.config import MAX_TOTAL_SIZE_BYTES
from app.database import db, SUPPORTED_EXTENSIONS
```

**Step 2: Commit**

```bash
git add backend/app/routes/tables.py
git commit -m "feat: update upload route to accept CSV, JSON, Parquet, and Excel files"
```

---

### Task 7: Update frontend FileUpload component for multi-format

**Files:**
- Modify: `frontend/src/components/FileUpload.tsx:21-25, 72-76`

**Step 1: Update file validation and accept attribute**

In `frontend/src/components/FileUpload.tsx`, change the `handleFiles` validation:

```typescript
const SUPPORTED_EXTENSIONS = ['.csv', '.json', '.parquet', '.xlsx', '.xls'];

const handleFiles = useCallback(async (fileList: FileList) => {
  const files = Array.from(fileList);
  const unsupported = files.filter(f => {
    const ext = f.name.toLowerCase().slice(f.name.lastIndexOf('.'));
    return !SUPPORTED_EXTENSIONS.includes(ext);
  });
  if (unsupported.length > 0) {
    alert(t('unsupportedFormat'));
    return;
  }
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  if (totalSize > maxTotalSizeBytes) {
    alert(t('fileTooLarge', { maxSize: `${maxTotalSizeBytes / (1024 * 1024)}MB` }));
    return;
  }
  setUploading(true);
  try {
    await onUpload(files);
  } finally {
    setUploading(false);
  }
}, [onUpload, t, maxTotalSizeBytes]);
```

Define `SUPPORTED_EXTENSIONS` as a module-level constant above the component.

Update the file input `accept` attribute:

```tsx
<input
  ref={inputRef}
  type="file"
  accept=".csv,.json,.parquet,.xlsx,.xls"
  multiple
  className="file-upload__input"
  onChange={(e) => {
    if (e.target.files && e.target.files.length > 0) handleFiles(e.target.files);
    e.target.value = '';
  }}
/>
```

**Step 2: Commit**

```bash
git add frontend/src/components/FileUpload.tsx
git commit -m "feat: update FileUpload to accept CSV, JSON, Parquet, and Excel files"
```

---

### Task 8: Update frontend App.tsx to handle Excel multi-table responses

**Files:**
- Modify: `frontend/src/App.tsx:57-82`

**Step 1: Update handleFileUpload**

In `frontend/src/App.tsx`, update `handleFileUpload` to handle both single table and array responses (Excel can return multiple tables):

```typescript
const handleFileUpload = useCallback(
  async (files: File[]) => {
    setError(null);
    let lastName = '';
    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);
        const response = await fetch('/api/upload', {
          method: 'POST',
          body: formData,
        });
        if (!response.ok) throw new Error('Failed to upload file');
        const result = await response.json();
        // Handle both single table and array of tables (Excel with multiple sheets)
        if (Array.isArray(result)) {
          lastName = result[result.length - 1]?.name || '';
        } else {
          lastName = result.name;
        }
      }
      await refreshTables();
      if (lastName) {
        setEditorQuery(`SELECT * FROM "${lastName}" LIMIT 100`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to upload file');
    }
  },
  [refreshTables]
);
```

**Step 2: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat: handle multi-table responses from Excel uploads"
```

---

### Task 9: Update i18n strings

**Files:**
- Modify: `frontend/src/i18n/en.json`
- Modify: `frontend/src/i18n/zh-TW.json`

**Step 1: Update en.json**

Change these keys in `frontend/src/i18n/en.json`:

```json
"uploadDropText": "Drop files here or click to browse (CSV, JSON, Parquet, Excel — up to {maxSize} in total)",
"unsupportedFormat": "Unsupported file format. Supported: CSV, JSON, Parquet, Excel (.xlsx/.xls).",
"noTables": "No tables yet. Upload a file to get started."
```

Remove the old `csvOnly` key and add the new `unsupportedFormat` key.

**Step 2: Update zh-TW.json**

Change these keys in `frontend/src/i18n/zh-TW.json`:

```json
"uploadDropText": "拖放檔案至此處，或點擊瀏覽（CSV、JSON、Parquet、Excel — 總共上限 {maxSize}）",
"unsupportedFormat": "不支援的檔案格式。支援格式：CSV、JSON、Parquet、Excel (.xlsx/.xls)。",
"noTables": "尚無資料表。請上傳檔案以開始使用。"
```

Remove the old `csvOnly` key and add the new `unsupportedFormat` key.

**Step 3: Commit**

```bash
git add frontend/src/i18n/en.json frontend/src/i18n/zh-TW.json
git commit -m "feat: update i18n strings for multi-format file upload"
```

---

### Task 10: Manual integration test

**Step 1: Start the backend**

Run: `cd backend && poetry run uvicorn app.main:app --reload`

**Step 2: Start the frontend**

Run: `cd frontend && npm run dev`

**Step 3: Test each format**

Create small test files and upload each via the UI:

1. **CSV** — existing functionality, should still work
2. **JSON** — create a small file: `[{"name":"Alice","age":30},{"name":"Bob","age":25}]`, upload, verify table loads
3. **Parquet** — if available, upload a small Parquet file; otherwise skip (DuckDB's `read_parquet` is well-tested)
4. **Excel** — create an `.xlsx` with 2 sheets, upload, verify two tables appear with correct naming

**Step 4: Test error cases**

1. Upload an unsupported file (e.g. `.txt`) — should see error message
2. Upload a file exceeding size limit — should see size error
3. Upload multiple files at once — should all load

**Step 5: Final commit**

```bash
git add -A
git commit -m "feat: multi-format file upload (CSV, JSON, Parquet, Excel)"
```
