"""Utilities for manipulating Claude Agent SDK session JSONL files."""

import json
import os
import tempfile
from pathlib import Path


def get_session_path(session_id: str) -> Path:
    """Construct the path to a session JSONL file.

    The Claude Agent SDK stores session files at:
        ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl

    where <encoded-cwd> replaces "/" with "-" in the current working directory.
    """
    cwd = os.getcwd()
    encoded_cwd = cwd.replace("/", "-")
    return Path.home() / ".claude" / "projects" / encoded_cwd / f"{session_id}.jsonl"


def _is_user_query(entry: dict) -> bool:
    """Return True if the JSONL entry is an actual user query (not a tool result).

    User query entries have type "user" with message.content as a string.
    Tool result entries also have type "user" but message.content is a list.
    """
    if entry.get("type") != "user":
        return False
    message = entry.get("message", {})
    content = message.get("content")
    return isinstance(content, str)


def truncate_session(session_id: str, user_message_index: int) -> None:
    """Truncate a session JSONL file at the given user message index.

    Reads the session file, counts user query entries, and truncates the file
    so that all lines from the specified user message onward are removed.

    Args:
        session_id: The session identifier.
        user_message_index: Zero-based index of the user message at which to
            truncate. All lines from this user message onward are discarded.

    Raises:
        FileNotFoundError: If the session file does not exist.
        ValueError: If user_message_index is not found in the session.
    """
    session_path = get_session_path(session_id)

    if not session_path.exists():
        raise FileNotFoundError(f"Session file not found: {session_path}")

    lines = session_path.read_text().splitlines(keepends=True)

    truncation_line: int | None = None
    user_count = 0

    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            entry = json.loads(stripped)
        except json.JSONDecodeError:
            continue

        if _is_user_query(entry):
            if user_count == user_message_index:
                truncation_line = i
                break
            user_count += 1

    if truncation_line is None:
        raise ValueError(
            f"User message index {user_message_index} not found in session {session_id}"
        )

    truncated_content = "".join(lines[:truncation_line])

    # Atomic write: write to temp file in the same directory, then replace
    dir_path = session_path.parent
    fd, tmp_path = tempfile.mkstemp(dir=dir_path, suffix=".jsonl.tmp")
    try:
        with os.fdopen(fd, "w") as tmp_file:
            tmp_file.write(truncated_content)
        os.replace(tmp_path, session_path)
    except BaseException:
        # Clean up temp file on failure
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
