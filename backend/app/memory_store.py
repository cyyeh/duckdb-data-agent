"""SQLite-backed memory store for conversations and messages."""

import json
import os
import sqlite3
import threading
import uuid
from datetime import datetime, timezone

from app.config import MEMORY_DB_PATH


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class MemoryStore:
    """Thread-safe SQLite store for conversation history.

    Uses WAL mode for concurrent reads, a threading.Lock for write
    serialisation, and CASCADE deletes on messages.
    """

    def __init__(self, db_path: str = MEMORY_DB_PATH) -> None:
        self._db_path = db_path
        self._lock = threading.Lock()
        self._ensure_dir()
        self._init_schema()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _ensure_dir(self) -> None:
        os.makedirs(os.path.dirname(self._db_path), exist_ok=True)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def _init_schema(self) -> None:
        with self._lock:
            conn = self._connect()
            try:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS conversations (
                        id         TEXT PRIMARY KEY,
                        user_id    TEXT NOT NULL DEFAULT 'default',
                        title      TEXT,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );

                    CREATE TABLE IF NOT EXISTS messages (
                        id              TEXT PRIMARY KEY,
                        conversation_id TEXT NOT NULL
                            REFERENCES conversations(id) ON DELETE CASCADE,
                        role            TEXT NOT NULL,
                        content         TEXT NOT NULL,
                        metadata        TEXT,
                        created_at      TEXT NOT NULL,
                        sort_order      INTEGER NOT NULL
                    );

                    CREATE INDEX IF NOT EXISTS idx_messages_conv_order
                        ON messages(conversation_id, sort_order);

                    CREATE INDEX IF NOT EXISTS idx_conversations_user_updated
                        ON conversations(user_id, updated_at);
                    """
                )
                # Migration: add session_id column
                try:
                    conn.execute(
                        "ALTER TABLE conversations ADD COLUMN session_id TEXT NOT NULL DEFAULT ''"
                    )
                except sqlite3.OperationalError:
                    pass  # column already exists
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_conversations_session "
                    "ON conversations(session_id)"
                )
                conn.commit()
            finally:
                conn.close()

    # ------------------------------------------------------------------
    # Conversations
    # ------------------------------------------------------------------

    def create_conversation(
        self,
        user_id: str = "default",
        title: str | None = None,
        session_id: str = "",
    ) -> dict:
        now = _now_iso()
        conv_id = str(uuid.uuid4())
        row = {
            "id": conv_id,
            "user_id": user_id,
            "title": title,
            "session_id": session_id,
            "created_at": now,
            "updated_at": now,
        }
        with self._lock:
            conn = self._connect()
            try:
                conn.execute(
                    """
                    INSERT INTO conversations (id, user_id, title, session_id, created_at, updated_at)
                    VALUES (:id, :user_id, :title, :session_id, :created_at, :updated_at)
                    """,
                    row,
                )
                conn.commit()
            finally:
                conn.close()
        return row

    def list_conversations(
        self,
        user_id: str = "default",
        limit: int = 50,
        offset: int = 0,
        session_id: str = "",
    ) -> list[dict]:
        with self._lock:
            conn = self._connect()
            try:
                rows = conn.execute(
                    """
                    SELECT * FROM conversations
                    WHERE user_id = ? AND session_id = ?
                    ORDER BY updated_at DESC
                    LIMIT ? OFFSET ?
                    """,
                    (user_id, session_id, limit, offset),
                ).fetchall()
            finally:
                conn.close()
        return [dict(r) for r in rows]

    def get_conversation(self, conversation_id: str) -> dict | None:
        with self._lock:
            conn = self._connect()
            try:
                row = conn.execute(
                    "SELECT * FROM conversations WHERE id = ?",
                    (conversation_id,),
                ).fetchone()
                if row is None:
                    return None
                conv = dict(row)
                msgs = conn.execute(
                    """
                    SELECT * FROM messages
                    WHERE conversation_id = ?
                    ORDER BY sort_order
                    """,
                    (conversation_id,),
                ).fetchall()
            finally:
                conn.close()
        conv["messages"] = [dict(m) for m in msgs]
        return conv

    def update_conversation(self, conversation_id: str, title: str) -> bool:
        with self._lock:
            conn = self._connect()
            try:
                cur = conn.execute(
                    """
                    UPDATE conversations
                    SET title = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (title, _now_iso(), conversation_id),
                )
                conn.commit()
                changed = cur.rowcount > 0
            finally:
                conn.close()
        return changed

    def delete_conversation(self, conversation_id: str) -> bool:
        with self._lock:
            conn = self._connect()
            try:
                cur = conn.execute(
                    "DELETE FROM conversations WHERE id = ?",
                    (conversation_id,),
                )
                conn.commit()
                changed = cur.rowcount > 0
            finally:
                conn.close()
        return changed

    def delete_conversations_by_session(self, session_id: str) -> int:
        """Delete all conversations with the given session_id.

        Returns the number of deleted rows.
        """
        with self._lock:
            conn = self._connect()
            try:
                cur = conn.execute(
                    "DELETE FROM conversations WHERE session_id = ?",
                    (session_id,),
                )
                conn.commit()
                deleted = cur.rowcount
            finally:
                conn.close()
        return deleted

    # ------------------------------------------------------------------
    # Messages
    # ------------------------------------------------------------------

    def add_message(
        self,
        conversation_id: str,
        role: str,
        content: str,
        metadata: dict | None = None,
    ) -> dict:
        msg_id = str(uuid.uuid4())
        now = _now_iso()
        meta_json = json.dumps(metadata) if metadata is not None else None

        with self._lock:
            conn = self._connect()
            try:
                # Determine next sort_order for this conversation.
                row = conn.execute(
                    """
                    SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
                    FROM messages
                    WHERE conversation_id = ?
                    """,
                    (conversation_id,),
                ).fetchone()
                next_order = row["next_order"]

                conn.execute(
                    """
                    INSERT INTO messages
                        (id, conversation_id, role, content, metadata, created_at, sort_order)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (msg_id, conversation_id, role, content, meta_json, now, next_order),
                )
                # Touch the conversation's updated_at timestamp.
                conn.execute(
                    "UPDATE conversations SET updated_at = ? WHERE id = ?",
                    (now, conversation_id),
                )
                conn.commit()
            finally:
                conn.close()

        return {
            "id": msg_id,
            "conversation_id": conversation_id,
            "role": role,
            "content": content,
            "metadata": meta_json,
            "created_at": now,
            "sort_order": next_order,
        }

    def list_messages(self, conversation_id: str) -> list[dict]:
        with self._lock:
            conn = self._connect()
            try:
                rows = conn.execute(
                    """
                    SELECT * FROM messages
                    WHERE conversation_id = ?
                    ORDER BY sort_order
                    """,
                    (conversation_id,),
                ).fetchall()
            finally:
                conn.close()
        return [dict(r) for r in rows]


# Module-level singleton
memory_store = MemoryStore()
