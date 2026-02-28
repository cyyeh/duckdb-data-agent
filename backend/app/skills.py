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
    for line in frontmatter.splitlines():
        if ":" in line:
            key, _, val = line.partition(":")
            meta[key.strip()] = val.strip()
    return {"name": meta.get("name", ""), "description": meta.get("description", ""), "content": body}


def _write_skill_md(path: str, name: str, description: str, content: str) -> None:
    """Write a SKILL.md file with YAML frontmatter."""
    text = f"---\nname: {name}\ndescription: {description}\n---\n\n{content}\n"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


def list_skills(skills_dir: str) -> list[dict]:
    """List all skills (name + description only)."""
    if not os.path.isdir(skills_dir):
        return []
    result = []
    for entry in sorted(os.listdir(skills_dir)):
        skill_path = os.path.join(skills_dir, entry, "SKILL.md")
        if os.path.isdir(os.path.join(skills_dir, entry)) and os.path.isfile(skill_path):
            with open(skill_path) as f:
                parsed = _parse_skill_md(f.read())
            result.append({"name": parsed["name"] or entry, "description": parsed["description"]})
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
    """Delete a skill directory. Raises SkillValidationError if not found."""
    skill_dir = os.path.join(skills_dir, name)
    if not os.path.isdir(skill_dir):
        raise SkillValidationError(f"Skill \"{name}\" not found.")
    shutil.rmtree(skill_dir)
