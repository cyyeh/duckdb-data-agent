from fastapi import APIRouter, Header, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.memory_store import memory_store

router = APIRouter(prefix="/api/conversations", tags=["conversations"])


class CreateConversationRequest(BaseModel):
    user_id: str = "default"
    title: str | None = None


class UpdateConversationRequest(BaseModel):
    title: str


@router.get("")
async def list_conversations(
    user_id: str = Query("default"),
    limit: int = Query(50),
    offset: int = Query(0),
    x_session_id: str = Header(""),
):
    return memory_store.list_conversations(
        user_id=user_id, limit=limit, offset=offset, session_id=x_session_id,
    )


@router.post("")
async def create_conversation(
    request: CreateConversationRequest,
    x_session_id: str = Header(""),
):
    return memory_store.create_conversation(
        user_id=request.user_id, title=request.title, session_id=x_session_id,
    )


@router.get("/{conversation_id}")
async def get_conversation(conversation_id: str):
    conv = memory_store.get_conversation(conversation_id)
    if conv is None:
        return JSONResponse(status_code=404, content={"error": "Conversation not found"})
    return conv


@router.put("/{conversation_id}")
async def update_conversation(conversation_id: str, request: UpdateConversationRequest):
    if not memory_store.update_conversation(conversation_id, request.title):
        return JSONResponse(status_code=404, content={"error": "Conversation not found"})
    return {"status": "ok"}


@router.delete("/{conversation_id}")
async def delete_conversation(conversation_id: str):
    if not memory_store.delete_conversation(conversation_id):
        return JSONResponse(status_code=404, content={"error": "Conversation not found"})
    return {"status": "ok"}
