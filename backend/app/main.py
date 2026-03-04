import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from app.routes import tables, query, chat, langfuse_status, config, session, skills, conversations, memories
from app.sandbox_manager import sandbox_manager
from app.mcp_sse import mcp_app
from app.proxy import router as proxy_router
from app.config import CORS_ALLOWED_ORIGINS

logger = logging.getLogger(__name__)

from app.session_manager import session_manager
from app.memory_store import memory_store


async def _cleanup_loop():
    while True:
        await asyncio.sleep(60)
        try:
            removed = session_manager.cleanup_stale(ttl_seconds=300)
            for sid in removed:
                memory_store.delete_conversations_by_session(sid)
            if removed:
                logger.info("Background cleanup: removed %d stale sessions", len(removed))
            if sandbox_manager is not None:
                sandbox_removed = await sandbox_manager.cleanup_expired()
                if sandbox_removed:
                    logger.info("Background cleanup: removed %d expired sandboxes", sandbox_removed)
        except Exception:
            logger.exception("Error in background cleanup loop")


@asynccontextmanager
async def lifespan(app):
    # Clean up orphaned sandboxes from a previous unclean shutdown.
    if sandbox_manager is not None:
        orphans = await sandbox_manager.cleanup_orphaned()
        if orphans:
            logger.info("Startup: cleaned up %d orphaned sandboxes", orphans)
    task = asyncio.create_task(_cleanup_loop())
    yield
    task.cancel()
    if sandbox_manager is not None:
        await sandbox_manager.shutdown_all()


app = FastAPI(title="DuckDB Data Agent API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOWED_ORIGINS,
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
app.include_router(skills.router)
app.include_router(proxy_router)
app.include_router(conversations.router)
app.include_router(memories.router)


app.mount("/mcp", mcp_app)


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
        file_path = (STATIC_DIR / full_path).resolve()
        # Prevent path traversal: ensure resolved path is inside STATIC_DIR
        if full_path and file_path.is_file() and file_path.is_relative_to(STATIC_DIR.resolve()):
            return FileResponse(file_path)
        return FileResponse(STATIC_DIR / "index.html")
