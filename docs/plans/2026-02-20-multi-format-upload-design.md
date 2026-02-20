# Multi-Format File Upload Design

## Problem

The app currently only supports CSV file uploads. Users need to upload CSV, JSON, Parquet, and Excel files to analyze data in DuckDB.

## Decisions

| Aspect | Decision |
|--------|----------|
| Formats | CSV, JSON (array of objects), Parquet, Excel (.xlsx/.xls) |
| Approach | DuckDB native readers for CSV/JSON/Parquet; openpyxl for Excel |
| Size limit | Combined total across all uploaded files, existing `MAX_TOTAL_SIZE_BYTES` |
| Multi-file | Multiple files in one upload, immediate upload on drop/select |
| Excel sheets | All sheets become separate tables, named `{filename}_{sheetname}` |
| Error handling | Fail individual files, continue others, report per-file errors |
| New dependency | `openpyxl` added to backend requirements |

## Backend: Database Layer

New methods on the `Database` class:

- `load_json(file_bytes, filename, table_name)` — Write to temp `.json` file, run `CREATE OR REPLACE TABLE AS SELECT * FROM read_json_auto(path)`, clean up.
- `load_parquet(file_bytes, filename, table_name)` — Same pattern with `read_parquet(path)`.
- `load_excel(file_bytes, filename)` — Use openpyxl to enumerate sheets. For each sheet, convert to CSV in a temp file, then load via existing `load_csv()`. Table names: `{base_name}_{sheet_name}` (sanitized). Returns a list of table infos.
- `load_file(file_bytes, filename)` — Dispatcher that detects extension and routes to the appropriate loader. Returns one or more table infos.

## Backend: Upload Route

Changes to `POST /api/upload`:

- Accept `.csv`, `.json`, `.parquet`, `.xlsx`, `.xls` files (reject others with HTTP 400).
- Accept multiple files in a single request (multiple form-data file parts).
- Check combined size of incoming files against `MAX_TOTAL_SIZE_BYTES`. Track total uploaded bytes on the `Database` instance.
- Loop through files, call `db.load_file()` for each. If one fails, report the error but continue loading others.
- Response: list of results per file — either success with table info(s) or error with message.
- Rename function from `upload_csv` to `upload_files`.

## Frontend: FileUpload Component

- Update `accept` attribute to `.csv,.json,.parquet,.xlsx,.xls`.
- Enable `multiple` on the file input and drag-and-drop handler.
- Validate each file's extension against allowed list.
- Check combined size (new files + already uploaded) against `maxTotalSizeBytes`.
- Immediate upload on drop/select (no preview step).
- Update display text to reference all supported formats.

## i18n

Update `en.json` and `zh-TW.json`:

- Change "CSV" references to "CSV, JSON, Parquet, Excel" in upload-related strings.
- Update file type error messages to list all accepted formats.
- Keep the Titanic sample dataset label unchanged.

## Data Flow

```
User drops/selects files (CSV, JSON, Parquet, or Excel)
    |
Frontend: validate extensions, check combined size
    |
POST /api/upload (multipart/form-data, multiple files)
    |
Backend: for each file:
    |-- check extension -> route to loader
    |-- .csv  -> db.load_csv()  -> read_csv_auto()
    |-- .json -> db.load_json() -> read_json_auto()
    |-- .parquet -> db.load_parquet() -> read_parquet()
    |-- .xlsx/.xls -> db.load_excel() -> openpyxl per sheet -> load_csv()
    |
Response: [{ file, status, tables[] }]
    |
Frontend: refresh tables, update sidebar
```

## Error Handling

- Unsupported extension: HTTP 400 per file, skip that file.
- Combined size exceeded: HTTP 413, reject entire request before processing.
- Individual file parse error: report error for that file, continue others.
- Excel with no sheets: report error for that file.
