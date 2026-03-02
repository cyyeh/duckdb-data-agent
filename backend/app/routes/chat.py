from typing import Literal

from fastapi import APIRouter, Depends, Header
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from app.agent import stream_chat
from app.database import Database
from app.dependencies import get_session_db
from app.pending_questions import pending_question_store

router = APIRouter(prefix="/api", tags=["chat"])


class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None
    langfuse_session_id: str | None = None
    conversation_history: list[dict] = []
    skills: list[str] | None = None
    conversation_id: str | None = None
    chart_library: Literal["plotly", "vegalite"] = "plotly"


class ChatEditRequest(BaseModel):
    new_message: str
    conversation_history: list[dict] = []
    langfuse_session_id: str | None = None
    conversation_id: str | None = None
    chart_library: Literal["plotly", "vegalite"] = "plotly"


class QuestionResponseRequest(BaseModel):
    question_id: str
    answers: list[str] = []
    free_text: str | None = None


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
            skills=request.skills,
            conversation_id=request.conversation_id,
            chart_library=request.chart_library,
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
            conversation_id=request.conversation_id,
            chart_library=request.chart_library,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/chat/respond")
async def respond_to_question(
    request: QuestionResponseRequest,
    x_session_id: str = Header(...),
):
    """Respond to a pending user question from the agent."""
    pending = pending_question_store.get_pending(x_session_id)
    if pending is None or pending["question_id"] != request.question_id:
        return JSONResponse(status_code=404, content={"error": "No pending question found"})

    answer = {"answers": request.answers}
    if request.free_text:
        answer["free_text"] = request.free_text
    pending_question_store.respond(x_session_id, request.question_id, answer)
    return {"status": "ok"}
