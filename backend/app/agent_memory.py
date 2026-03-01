import os

from app.config import MEMORIES_DIR


def _memory_path(user_id: str = "default") -> str:
    user_dir = os.path.join(MEMORIES_DIR, user_id)
    os.makedirs(user_dir, exist_ok=True)
    return os.path.join(user_dir, "MEMORY.md")


def read_memories(user_id: str = "default") -> str:
    path = _memory_path(user_id)
    if not os.path.exists(path):
        return ""
    with open(path, "r") as f:
        return f.read()


def save_memory(content: str, category: str = "fact", user_id: str = "default") -> str:
    path = _memory_path(user_id)
    valid_categories = {"preference", "fact", "pattern"}
    if category not in valid_categories:
        category = "fact"

    # Read existing or create skeleton
    if os.path.exists(path):
        text = open(path, "r").read()
    else:
        text = "# Agent Memory\n\n## Preferences\n\n## Facts\n\n## Patterns\n"

    section_header = f"## {category.capitalize()}s"
    if category == "fact":
        section_header = "## Facts"
    elif category == "preference":
        section_header = "## Preferences"
    elif category == "pattern":
        section_header = "## Patterns"

    entry = f"- {content}"

    # Duplicate check
    if entry in text:
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
    if not os.path.exists(path):
        return "No memories found."
    text = open(path, "r").read()
    entry = f"- {content}"
    if entry not in text:
        return "Memory not found."
    text = text.replace(entry + "\n", "")
    with open(path, "w") as f:
        f.write(text)
    return "Memory forgotten."
