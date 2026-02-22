from fastapi import APIRouter, Depends, Header
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.agent import stream_chat
from app.database import Database
from app.dependencies import get_session_db

router = APIRouter(prefix="/api", tags=["chat"])


class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None
    langfuse_session_id: str | None = None
    conversation_history: list[dict] = []


class ChatEditRequest(BaseModel):
    new_message: str
    conversation_history: list[dict] = []
    langfuse_session_id: str | None = None


@router.post("/chat")
async def chat(
    request: ChatRequest,
    db: Database = Depends(get_session_db),
    x_session_id: str = Header(...),
):
    return StreamingResponse(
        stream_chat(
            request.message,
            request.session_id,
            db,
            conversation_history=request.conversation_history or None,
            langfuse_session_id=request.langfuse_session_id,
            backend_session_id=x_session_id,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/chat/edit")
async def chat_edit(
    request: ChatEditRequest,
    db: Database = Depends(get_session_db),
    x_session_id: str = Header(...),
):
    """Edit a message: start a fresh session with conversation history as context."""
    return StreamingResponse(
        stream_chat(
            request.new_message,
            session_id=None,
            db=db,
            conversation_history=request.conversation_history,
            langfuse_session_id=request.langfuse_session_id,
            backend_session_id=x_session_id,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
