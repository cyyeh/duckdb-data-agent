from fastapi import APIRouter, Header, Request, Response

from app.session_manager import session_manager

router = APIRouter(prefix="/api", tags=["session"])


@router.post("/heartbeat")
async def heartbeat(x_session_id: str = Header(...)):
    found = session_manager.touch(x_session_id)
    if not found:
        return Response(status_code=404)
    return {"ok": True}


@router.post("/session/cleanup")
async def cleanup_session(
    request: Request,
    x_session_id: str | None = Header(None),
):
    # Accept session_id from: header, JSON body, or query param (legacy).
    effective_id = x_session_id
    if not effective_id:
        try:
            body = await request.json()
            effective_id = body.get("session_id")
        except Exception:
            pass
    if not effective_id:
        effective_id = request.query_params.get("session_id")
    if effective_id:
        session_manager.destroy(effective_id)
    return {"ok": True}
