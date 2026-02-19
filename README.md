# DuckDB Data Agent

A SQL playground with an AI-powered data analysis agent. Upload CSV files, write SQL queries, or ask questions in plain English — powered by [DuckDB](https://duckdb.org/) on a lightweight [FastAPI](https://fastapi.tiangolo.com/) backend with a React frontend.

## Features

### SQL Playground

- **DuckDB SQL engine** — Fast, in-process analytical database on the backend
- **CSV file upload** — Drag-and-drop or click to import CSV files (up to 500 MB) with automatic schema detection
- **Sample dataset** — One-click load of the Titanic dataset to get started quickly
- **SQL query editor** — Write and execute queries with Ctrl/Cmd+Enter
- **Interactive results** — Sortable columns, per-column filters, and global search across results
- **EXPLAIN support** — Markdown-rendered output for `EXPLAIN` and `EXPLAIN ANALYZE` queries
- **Table sidebar** — Collapsible panel to browse tables, inspect columns, and view types

### AI Agent

- **Natural language queries** — Ask questions about your data in plain English; the agent writes and executes SQL for you
- **Streaming responses** — Real-time token streaming powered by Claude via the [Anthropic Agent SDK](https://github.com/anthropics/anthropic-sdk-python)
- **Visible reasoning** — Collapsible thinking block shows the agent's intermediate steps and SQL queries
- **Inline results** — Query results rendered inline within the conversation
- **Privacy-conscious** — Requires an Anthropic API key stored in a server-side `.env` file; your data and key are never sent anywhere besides the Anthropic API

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Python](https://www.python.org/) 3.12+
- [Poetry](https://python-poetry.org/)

### Installation

```bash
make install
```

Or install frontend and backend separately:

```bash
npm install
cd backend && poetry install
```

### Configuration

Copy the example environment file and add your Anthropic API key:

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env` and set your key:

```
ANTHROPIC_API_KEY=sk-ant-...
```

> The API key is only needed for the AI agent. The SQL playground works without it, but both require the backend running.

### Development

Start both the frontend and backend:

```bash
make dev
```

Or run them separately:

```bash
make frontend   # http://localhost:5173
make backend    # http://localhost:8000
```

Open http://localhost:5173 to use the app. The Vite dev server proxies `/api` requests to the backend automatically.

## Production Build

```bash
npm run build
npm run preview
```

## Deployment

A GitHub Actions workflow automatically builds and deploys the frontend to GitHub Pages on push to `main`. The backend must be hosted separately for the app to function.

## Project Structure

```
├── src/                    # React frontend
│   ├── components/         #   UI components (editor, results, sidebar, chat)
│   ├── agent/              #   Agent service (SSE event handling)
│   ├── AgentContext.tsx     #   Agent state management
│   └── types.ts            #   Shared TypeScript interfaces
├── backend/                # FastAPI backend
│   └── app/
│       ├── main.py         #   App setup & CORS
│       ├── database.py     #   DuckDB connection & query execution
│       ├── agent.py        #   Agent loop & SSE streaming
│       ├── tools.py        #   MCP tool definitions
│       └── routes/         #   API endpoints (tables, query, chat)
└── Makefile                # Dev commands (install, dev, clean)
```

## Tech Stack

**Frontend**
- [React](https://react.dev/) 18 + [TypeScript](https://www.typescriptlang.org/)
- [Vite](https://vite.dev/)

**Backend**
- [FastAPI](https://fastapi.tiangolo.com/) + [Uvicorn](https://www.uvicorn.org/)
- [DuckDB](https://duckdb.org/) (Python)
- [Anthropic Agent SDK](https://github.com/anthropics/anthropic-sdk-python)

## License

[MIT](LICENSE.txt)
