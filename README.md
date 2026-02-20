# DuckDB Data Agent

> **Note:** This project is built with [Claude Code](https://claude.com/product/claude-code)(using Opus 4.6 and [superpowers](https://github.com/obra/superpowers)) by more than 95% and human-reviewed by author.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

An AI-powered data analysis agent with a built-in SQL playground. Upload CSV files and ask questions in plain English, or switch to the SQL editor for direct queries — powered by [DuckDB](https://duckdb.org/) on a lightweight [FastAPI](https://fastapi.tiangolo.com/) backend with a React frontend. The app opens in Agent Mode by default so you can start analyzing data immediately.

## Features

### General

- **DuckDB SQL engine** — Fast, in-process analytical database on the backend
- **CSV file upload** — Drag-and-drop or click to import CSV files (up to 500 MB) with automatic schema detection; the upload UI appears when no tables are loaded and disappears once data is available
- **Sample dataset** — One-click load of the Titanic dataset to get started quickly
- **Table sidebar** — Collapsible panel to browse tables, inspect columns, and view types
- **Dark / light mode** — Toggle between dark and light themes with the sun/moon button in the header; respects your OS preference on first visit and remembers your choice across sessions
- **Internationalization (i18n)** — Switch between English and Traditional Chinese with the EN/中 toggle in the header; auto-detects your OS language on first visit and remembers your choice across sessions

### Agent Mode (default mode)

- **Natural language queries** — Ask questions about your data in plain English; the agent writes and executes SQL for you
- **Streaming responses** — Real-time token streaming powered by Claude via the [Anthropic Agent SDK](https://github.com/anthropics/anthropic-sdk-python)
- **Visible reasoning** — Collapsible thinking block shows the agent's intermediate steps and SQL queries
- **Inline results** — Query results rendered inline within the conversation
- **Edit & delete messages** — Hover over any user message to edit or delete it; editing re-sends the modified query with prior conversation as context, deleting rewinds the conversation to that point
- **Privacy-conscious** — Requires an Anthropic API key stored in a server-side `.env` file; your data and key are never sent anywhere besides the Anthropic API
- **Langfuse observability** (optional) — Built-in [Langfuse](https://langfuse.com/) tracing for monitoring agent interactions, with a one-click dashboard link in the UI

### Editor Mode

- **SQL query editor** — Write and execute queries with Ctrl/Cmd+Enter
- **Interactive results** — Sortable columns, per-column filters, and global search across results
- **EXPLAIN support** — Markdown-rendered output for `EXPLAIN` and `EXPLAIN ANALYZE` queries

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
cd frontend && npm install
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
ANTHROPIC_MODEL=sonnet    # optional, defaults to sonnet
```

> Both variables are only needed for the AI agent. The SQL playground works without them, but both require the backend running.

#### Langfuse (optional)

To enable agent tracing with [Langfuse](https://langfuse.com/), add these to `backend/.env`:

```
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com   # optional, defaults to cloud
```

When configured, every agent conversation is traced (LLM turns, tool calls, SQL execution) and a **Langfuse Traces** button appears in the agent panel header linking to your dashboard. When not configured, tracing is disabled with zero overhead.

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

## Production Build and Deployment

The project ships as a single Docker image that bundles the React frontend and FastAPI backend. A multi-stage `Dockerfile` builds the frontend, then copies the output into the backend's static directory.

### Build and run locally

```bash
docker build -t duckdb-data-agent .
docker run -p 10000:10000 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e LANGFUSE_PUBLIC_KEY=pk-lf-... \
  -e LANGFUSE_SECRET_KEY=sk-lf-... \
  duckdb-data-agent
```

Open http://localhost:10000 to use the app.

### Deploy to Render

A `render.yaml` is included for one-click deployment on [Render](https://render.com/):

1. Push this repo to GitHub.
2. In Render, create a new **Blueprint** and connect the repo.
3. Set the `ANTHROPIC_API_KEY` environment variable in the Render dashboard. Optionally set `ANTHROPIC_MODEL` to override the default model (`sonnet`). To enable Langfuse tracing, also set `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`.

Render will build the Docker image and deploy it automatically on every push to `main`.

## Project Structure

```
├── frontend/               # React frontend
│   ├── public/             #   Static assets (Langfuse icon)
│   ├── src/
│   │   ├── components/     #   UI components (editor, results, sidebar, chat)
│   │   ├── agent/          #   Agent service (SSE event handling)
│   │   ├── i18n/           #   Translation files (en.json, zh-TW.json)
│   │   ├── AgentContext.tsx #   Agent state management
│   │   ├── ThemeContext.tsx #   Dark/light theme state & persistence
│   │   ├── LanguageContext.tsx # i18n state, detection & translation
│   │   └── types.ts        #   Shared TypeScript interfaces
│   ├── index.html          #   HTML entry point
│   ├── package.json        #   npm config
│   └── vite.config.ts      #   Vite bundler config
├── backend/                # FastAPI backend
│   └── app/
│       ├── main.py         #   App setup & CORS
│       ├── config.py       #   Environment variables (API key, model)
│       ├── database.py     #   DuckDB connection & query execution
│       ├── agent.py        #   Agent loop & SSE streaming
│       ├── tracing.py      #   Langfuse client wrapper & initialization
│       ├── tools.py        #   Agent SDK tool definitions (execute_sql)
│       ├── data/           #   Sample datasets (titanic.csv)
│       └── routes/         #   API endpoints (tables, query, chat, langfuse status)
├── Dockerfile              # Multi-stage production build
├── render.yaml             # Render deployment config
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
- [Langfuse](https://langfuse.com/) (optional, for observability)

## License

[MIT](LICENSE.txt)
