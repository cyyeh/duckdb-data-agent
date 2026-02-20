from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.agent import stream_chat

router = APIRouter(prefix="/api", tags=["chat"])


class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None


class ChatEditRequest(BaseModel):
    new_message: str
    conversation_history: list[dict] = []


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
    """Edit a message: start a fresh session with conversation history as context."""
    return StreamingResponse(
        stream_chat(
            request.new_message,
            session_id=None,
            conversation_history=request.conversation_history,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
