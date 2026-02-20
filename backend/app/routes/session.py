from fastapi import APIRouter, Header, Response

from app.session_manager import session_manager

router = APIRouter(prefix="/api", tags=["session"])


@router.post("/heartbeat")
async def heartbeat(x_session_id: str = Header(...)):
    found = session_manager.touch(x_session_id)
    if not found:
        return Response(status_code=404)
    return {"ok": True}


@router.post("/session/cleanup")
async def cleanup_session(session_id: str | None = None):
    if session_id:
        session_manager.destroy(session_id)
    return {"ok": True}
