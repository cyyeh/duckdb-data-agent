import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from app.database import Database

logger = logging.getLogger(__name__)


@dataclass
class SessionEntry:
    db: Database
    last_seen_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


class SessionManager:
    def __init__(self) -> None:
        self._sessions: dict[str, SessionEntry] = {}

    def get_or_create(self, session_id: str) -> Database:
        if session_id not in self._sessions:
            logger.info("Creating new session: %s", session_id)
            self._sessions[session_id] = SessionEntry(db=Database())
        else:
            self._sessions[session_id].last_seen_at = datetime.now(timezone.utc)
        return self._sessions[session_id].db

    def touch(self, session_id: str) -> bool:
        if session_id not in self._sessions:
            return False
        self._sessions[session_id].last_seen_at = datetime.now(timezone.utc)
        return True

    def destroy(self, session_id: str) -> None:
        entry = self._sessions.pop(session_id, None)
        if entry is None:
            return
        try:
            entry.db.close()
        except Exception:
            pass
        logger.info("Destroyed session: %s", session_id)

    def cleanup_stale(self, ttl_seconds: int = 300) -> int:
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=ttl_seconds)
        stale = [
            sid for sid, entry in self._sessions.items()
            if entry.last_seen_at < cutoff
        ]
        for sid in stale:
            self.destroy(sid)
        return len(stale)


session_manager = SessionManager()
