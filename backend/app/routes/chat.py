from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.agent import stream_chat
from app.session import truncate_session

router = APIRouter(prefix="/api", tags=["chat"])


class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None


class ChatEditRequest(BaseModel):
    session_id: str
    user_message_index: int
    new_message: str


class ChatDeleteRequest(BaseModel):
    session_id: str
    user_message_index: int


@router.post("/chat")
async def chat(request: ChatRequest):
    return StreamingResponse(
        stream_chat(request.message, request.session_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/chat/edit")
async def chat_edit(request: ChatEditRequest):
    try:
        truncate_session(request.session_id, request.user_message_index)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Session not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return StreamingResponse(
        stream_chat(request.new_message, request.session_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/chat/delete")
async def chat_delete(request: ChatDeleteRequest):
    try:
        truncate_session(request.session_id, request.user_message_index)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Session not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {"ok": True}
