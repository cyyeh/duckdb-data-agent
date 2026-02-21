import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from app.routes import tables, query, chat, langfuse_status, config, session
from app import proxy as proxy_module

logger = logging.getLogger(__name__)

from app.session_manager import session_manager


async def _cleanup_loop():
    while True:
        await asyncio.sleep(60)
        removed = session_manager.cleanup_stale(ttl_seconds=300)
        if removed:
            logger.info("Background cleanup: removed %d stale sessions", removed)
        proxy_removed = proxy_module.proxy_token_store.cleanup_expired()
        if proxy_removed:
            logger.info("Background cleanup: removed %d expired proxy tokens", proxy_removed)


@asynccontextmanager
async def lifespan(app):
    task = asyncio.create_task(_cleanup_loop())
    yield
    task.cancel()


app = FastAPI(title="DuckDB Data Agent API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(tables.router)
app.include_router(query.router)
app.include_router(chat.router)
app.include_router(langfuse_status.router)
app.include_router(config.router)
app.include_router(session.router)
app.include_router(proxy_module.router)


@app.get("/api/health")
async def health():
    return {"status": "ok"}


# Serve frontend static files in production
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

if STATIC_DIR.is_dir():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="static-assets")

    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        """Serve frontend for any non-API route (SPA fallback)."""
        file_path = STATIC_DIR / full_path
        if full_path and file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(STATIC_DIR / "index.html")
