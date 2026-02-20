# Configurable Max Upload Size

## Overview

Make `MAX_TOTAL_SIZE_BYTES` configurable via an environment variable on the backend. The frontend fetches the value from a new `/api/config` API endpoint instead of using a hardcoded constant. The backend also enforces the limit server-side on the upload endpoint.

Default: 500MB (524288000 bytes).

## Architecture

### Backend

1. **`config.py`**: Add `MAX_TOTAL_SIZE_BYTES = int(os.getenv("MAX_TOTAL_SIZE_BYTES", str(500 * 1024 * 1024)))`.

2. **`routes/config.py`** (new): `GET /api/config` returns `{ "maxTotalSizeBytes": <value> }`. Extensible for future config values.

3. **`routes/tables.py`**: Add size validation in the upload endpoint. If `len(content) > MAX_TOTAL_SIZE_BYTES`, return HTTP 413 with an error message. This is per-file server-side enforcement.

4. **`main.py`**: Register the config router.

### Frontend

1. **`ConfigContext.tsx`** (new): React context + provider that fetches `/api/config` on mount. Follows the existing ThemeContext/LanguageContext pattern. Provides `maxTotalSizeBytes` with a 500MB default while loading.

2. **`FileUpload.tsx`**: Remove hardcoded `MAX_TOTAL_SIZE_BYTES` constant. Use `useConfig()` hook to get the value from context.

3. **`App.tsx`**: Wrap app with `ConfigProvider`.

### Environment

- Add `MAX_TOTAL_SIZE_BYTES` to `backend/.env.example` with documentation comment.

## Modified Files

| File | Change |
|------|--------|
| `backend/app/config.py` | Add env var |
| `backend/app/routes/config.py` | New config endpoint |
| `backend/app/routes/tables.py` | Add server-side size enforcement |
| `backend/app/main.py` | Register config router |
| `frontend/src/ConfigContext.tsx` | New context for app config |
| `frontend/src/components/FileUpload.tsx` | Use config context instead of hardcoded constant |
| `frontend/src/App.tsx` | Add ConfigProvider wrapper |
| `backend/.env.example` | Document new env var |
