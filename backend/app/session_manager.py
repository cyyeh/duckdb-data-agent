import logging
import os
import threading
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
        self._lock = threading.Lock()

    def get_or_create(self, session_id: str) -> Database:
        with self._lock:
            if session_id not in self._sessions:
                logger.info("Creating new session: %s", session_id)
                db_path = f"/tmp/duckdb-data-agent-{session_id}.duckdb"
                self._sessions[session_id] = SessionEntry(db=Database(db_path))
            else:
                self._sessions[session_id].last_seen_at = datetime.now(timezone.utc)
            return self._sessions[session_id].db

    def touch(self, session_id: str) -> bool:
        with self._lock:
            if session_id not in self._sessions:
                return False
            self._sessions[session_id].last_seen_at = datetime.now(timezone.utc)
            return True

    def destroy(self, session_id: str, delete_file: bool = True) -> None:
        with self._lock:
            entry = self._sessions.pop(session_id, None)
        if entry is None:
            return
        db_path = entry.db.db_path
        try:
            entry.db.conn.close()
        except Exception:
            pass
        if delete_file and db_path != ":memory:":
            for path in [db_path, db_path + ".wal"]:
                try:
                    os.remove(path)
                except FileNotFoundError:
                    pass
        logger.info("Destroyed session: %s (delete_file=%s)", session_id, delete_file)

    def cleanup_stale(self, ttl_seconds: int = 300) -> int:
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=ttl_seconds)
        with self._lock:
            stale = [
                sid for sid, entry in self._sessions.items()
                if entry.last_seen_at < cutoff
            ]
        for sid in stale:
            self.destroy(sid, delete_file=False)
        return len(stale)


session_manager = SessionManager()
