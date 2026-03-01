import os
import re
import shutil


class SkillValidationError(Exception):
    pass


_NAME_PATTERN = re.compile(r"^[a-z0-9-]+$")


def _validate_name(name: str) -> None:
    if not name or len(name) > 64 or not _NAME_PATTERN.match(name):
        raise SkillValidationError(
            "Skill name must be 1-64 characters, lowercase alphanumeric with hyphens."
        )


def _parse_skill_md(text: str) -> dict:
    """Parse a SKILL.md file into {name, description, content}."""
    if not text.startswith("---"):
        return {"name": "", "description": "", "content": text}
    try:
        end = text.index("---", 3)
    except ValueError:
        return {"name": "", "description": "", "content": text}
    frontmatter = text[3:end].strip()
    body = text[end + 3:].strip()
    meta: dict[str, str] = {}
    metadata: dict[str, str] = {}
    current_section: str | None = None
    for line in frontmatter.splitlines():
        if line.startswith("  ") and current_section == "metadata" and ":" in line:
            key, _, val = line.strip().partition(":")
            metadata[key.strip()] = val.strip()
        elif ":" in line:
            key, _, val = line.partition(":")
            k, v = key.strip(), val.strip()
            if not v and k == "metadata":
                current_section = "metadata"
            else:
                current_section = None
                meta[k] = v
    result: dict = {"name": meta.get("name", ""), "description": meta.get("description", ""), "content": body}
    if metadata.get("builtin", "").lower() == "true":
        result["builtin"] = True
    if meta.get("disabled", "").lower() == "true":
        result["disabled"] = True
    return result


def _write_skill_md(path: str, name: str, description: str, content: str,
                    *, builtin: bool = False, disabled: bool = False) -> None:
    """Write a SKILL.md file with YAML frontmatter."""
    lines = [f"name: {name}", f"description: {description}"]
    if disabled:
        lines.append("disabled: true")
    if builtin:
        lines.append("metadata:")
        lines.append("  builtin: true")
    text = "---\n" + "\n".join(lines) + "\n---\n\n" + content + "\n"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


def list_skills(skills_dir: str) -> list[dict]:
    """List all skills (name + description only).

    Ordering: built-in skills first, then by directory creation time
    (chronological).
    """
    if not os.path.isdir(skills_dir):
        return []
    result = []
    for entry in os.listdir(skills_dir):
        entry_dir = os.path.join(skills_dir, entry)
        skill_path = os.path.join(entry_dir, "SKILL.md")
        if os.path.isdir(entry_dir) and os.path.isfile(skill_path):
            with open(skill_path) as f:
                parsed = _parse_skill_md(f.read())
            item: dict = {"name": parsed["name"] or entry, "description": parsed["description"]}
            if parsed.get("builtin"):
                item["builtin"] = True
            if parsed.get("disabled"):
                item["disabled"] = True
            # Attach creation time for sorting (not included in response)
            stat = os.stat(entry_dir)
            item["_ctime"] = getattr(stat, "st_birthtime", stat.st_mtime)
            result.append(item)
    # Built-in skills first, then chronological order
    result.sort(key=lambda s: (not s.get("builtin", False), s["_ctime"]))
    for item in result:
        del item["_ctime"]
    return result


def get_skill(name: str, skills_dir: str) -> dict | None:
    """Get a single skill with full content. Returns None if not found."""
    skill_path = os.path.join(skills_dir, name, "SKILL.md")
    if not os.path.isfile(skill_path):
        return None
    with open(skill_path) as f:
        return _parse_skill_md(f.read())


def create_skill(name: str, description: str, content: str, skills_dir: str) -> None:
    """Create a new skill. Raises SkillValidationError on invalid input or duplicate."""
    _validate_name(name)
    skill_dir = os.path.join(skills_dir, name)
    if os.path.isdir(skill_dir):
        raise SkillValidationError(f"Skill \"{name}\" already exists.")
    _write_skill_md(os.path.join(skill_dir, "SKILL.md"), name, description, content)


def update_skill(name: str, description: str, content: str, skills_dir: str) -> None:
    """Update an existing skill. Raises SkillValidationError if not found."""
    skill_path = os.path.join(skills_dir, name, "SKILL.md")
    if not os.path.isfile(skill_path):
        raise SkillValidationError(f"Skill \"{name}\" not found.")
    _write_skill_md(skill_path, name, description, content)


def delete_skill(name: str, skills_dir: str) -> None:
    """Delete a skill directory. Raises SkillValidationError if not found or built-in."""
    skill_dir = os.path.join(skills_dir, name)
    if not os.path.isdir(skill_dir):
        raise SkillValidationError(f"Skill \"{name}\" not found.")
    skill_path = os.path.join(skill_dir, "SKILL.md")
    if os.path.isfile(skill_path):
        with open(skill_path) as f:
            parsed = _parse_skill_md(f.read())
        if parsed.get("builtin"):
            raise SkillValidationError(f"Cannot delete built-in skill \"{name}\".")
    shutil.rmtree(skill_dir)


def toggle_skill_disabled(name: str, disabled: bool, skills_dir: str) -> dict:
    """Toggle the disabled state of a skill. Returns the updated skill dict."""
    skill_path = os.path.join(skills_dir, name, "SKILL.md")
    if not os.path.isfile(skill_path):
        raise SkillValidationError(f"Skill \"{name}\" not found.")
    with open(skill_path) as f:
        parsed = _parse_skill_md(f.read())
    _write_skill_md(
        skill_path,
        parsed["name"] or name,
        parsed["description"],
        parsed["content"],
        builtin=parsed.get("builtin", False),
        disabled=disabled,
    )
    with open(skill_path) as f:
        return _parse_skill_md(f.read())
