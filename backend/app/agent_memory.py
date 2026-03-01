import os
import threading

from app.config import MEMORIES_DIR

_lock = threading.Lock()


def _memory_path(user_id: str = "default") -> str:
    user_dir = os.path.join(MEMORIES_DIR, user_id)
    os.makedirs(user_dir, exist_ok=True)
    return os.path.join(user_dir, "MEMORY.md")


_SKELETON = "# Agent Memory\n\n## Preferences\n\n## Facts\n\n## Patterns\n"


def read_memories(user_id: str = "default") -> str:
    path = _memory_path(user_id)
    with _lock:
        if not os.path.exists(path):
            return ""
        with open(path, "r") as f:
            return f.read()


def save_memory(content: str, category: str = "fact", user_id: str = "default") -> str:
    valid_categories = {"preference", "fact", "pattern"}
    if category not in valid_categories:
        category = "fact"

    section_headers = {
        "preference": "## Preferences",
        "fact": "## Facts",
        "pattern": "## Patterns",
    }
    section_header = section_headers[category]
    entry = f"- {content}"

    path = _memory_path(user_id)
    with _lock:
        if os.path.exists(path):
            with open(path, "r") as f:
                text = f.read()
        else:
            text = _SKELETON

        # Exact line-level duplicate check
        existing_lines = text.split("\n")
        if entry in existing_lines:
            return "Memory already exists."

        # Find section and append
        if section_header in text:
            section_start = text.index(section_header) + len(section_header)
            next_section = text.find("\n## ", section_start)
            if next_section == -1:
                text = text.rstrip() + f"\n{entry}\n"
            else:
                text = text[:next_section].rstrip() + f"\n{entry}\n" + text[next_section:]
        else:
            text = text.rstrip() + f"\n\n{section_header}\n{entry}\n"

        with open(path, "w") as f:
            f.write(text)
    return "Memory saved."


def forget_memory(content: str, user_id: str = "default") -> str:
    path = _memory_path(user_id)
    entry = f"- {content}"

    with _lock:
        if not os.path.exists(path):
            return "No memories found."
        with open(path, "r") as f:
            lines = f.readlines()

        found = False
        new_lines = []
        for line in lines:
            if line.rstrip("\n") == entry and not found:
                found = True
                continue
            new_lines.append(line)

        if not found:
            return "Memory not found."

        with open(path, "w") as f:
            f.writelines(new_lines)
    return "Memory forgotten."
