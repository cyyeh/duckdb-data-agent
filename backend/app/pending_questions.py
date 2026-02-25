import asyncio
import uuid


class PendingQuestionStore:
    """Thread-safe store for pending user questions.

    Coordinates between the SSE stream generator (which detects the tool call)
    and the /api/chat/respond endpoint (which receives the user's answer).
    """

    def __init__(self):
        self._pending: dict[str, dict] = {}  # keyed by session_id

    def create(self, session_id: str, question_data: dict) -> str:
        """Store a pending question and return a unique question_id."""
        question_id = str(uuid.uuid4())
        self._pending[session_id] = {
            "question_id": question_id,
            "data": question_data,
            "event": asyncio.Event(),
            "answer": None,
        }
        return question_id

    def get_pending(self, session_id: str) -> dict | None:
        """Get the pending question for a session, or None."""
        entry = self._pending.get(session_id)
        if entry is None:
            return None
        return {
            "question_id": entry["question_id"],
            "data": entry["data"],
        }

    def respond(self, session_id: str, question_id: str, answer: dict) -> None:
        """Set the answer for a pending question and signal the waiter."""
        entry = self._pending.get(session_id)
        if entry is None or entry["question_id"] != question_id:
            return
        entry["answer"] = answer
        entry["event"].set()

    async def wait(self, session_id: str, question_id: str, timeout: float = 300.0) -> dict | None:
        """Wait for the user's answer. Returns None on timeout."""
        entry = self._pending.get(session_id)
        if entry is None or entry["question_id"] != question_id:
            return None
        try:
            await asyncio.wait_for(entry["event"].wait(), timeout=timeout)
            return entry["answer"]
        except asyncio.TimeoutError:
            return None
        finally:
            # Clean up after wait completes (success or timeout)
            if session_id in self._pending and self._pending[session_id]["question_id"] == question_id:
                del self._pending[session_id]

    def cleanup(self, session_id: str) -> None:
        """Remove pending question for a session."""
        self._pending.pop(session_id, None)


# Singleton instance shared between MCP tool handler and /api/chat/respond endpoint
pending_question_store = PendingQuestionStore()
