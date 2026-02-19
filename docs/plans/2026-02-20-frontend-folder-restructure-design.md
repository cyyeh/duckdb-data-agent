# Frontend Folder Restructure Design

**Date:** 2026-02-20
**Goal:** Move all frontend-related files into a `frontend/` directory for clean separation from the backend.

## Target Structure

```
duckdb-data-agent/
├── frontend/                    # All frontend files
│   ├── src/                     # React source code
│   ├── public/                  # Static assets (titanic.csv)
│   ├── dist/                    # Build output (gitignored)
│   ├── node_modules/            # Dependencies (gitignored)
│   ├── index.html               # HTML entry point
│   ├── package.json
│   ├── package-lock.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── tsconfig.app.json
│   ├── tsconfig.node.json
│   └── eslint.config.js
│
├── backend/                     # Unchanged except static path in main.py
├── docs/
├── Dockerfile                   # Updated build paths
├── Makefile                     # Updated cd targets
├── render.yaml                  # No changes
├── .dockerignore                # Updated paths
├── .gitignore                   # Updated paths
└── README.md                    # Updated path references
```

## Files Moved

All of these move from project root into `frontend/`:
- `src/` -> `frontend/src/`
- `public/` -> `frontend/public/`
- `dist/` -> `frontend/dist/`
- `index.html` -> `frontend/index.html`
- `package.json` -> `frontend/package.json`
- `package-lock.json` -> `frontend/package-lock.json`
- `vite.config.ts` -> `frontend/vite.config.ts`
- `tsconfig.json` -> `frontend/tsconfig.json`
- `tsconfig.app.json` -> `frontend/tsconfig.app.json`
- `tsconfig.node.json` -> `frontend/tsconfig.node.json`
- `eslint.config.js` -> `frontend/eslint.config.js`

## Files Updated (Path References)

1. **Dockerfile** - Frontend build stage WORKDIR and COPY paths; dist copy to backend
2. **Makefile** - cd targets for frontend commands
3. **backend/app/main.py** - Static file serving path
4. **.dockerignore** - node_modules and dist paths
5. **.gitignore** - node_modules and dist paths
6. **README.md** - Any path references

## Constraints

- All functionality must remain identical
- No frontend source code changes (imports are relative within src/)
- Backend code unchanged except static file mount path
