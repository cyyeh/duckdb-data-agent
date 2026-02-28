import pytest
from app.skills import list_skills, get_skill, create_skill, update_skill, delete_skill, SkillValidationError


@pytest.fixture
def skills_dir(tmp_path):
    """Create a temporary skills directory with one seed skill."""
    skill_dir = tmp_path / "analyze-data"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        "---\nname: analyze-data\ndescription: Analyze data with DuckDB\n---\n\n# Analyze Data\n\nStep 1..."
    )
    return str(tmp_path)


def test_list_skills_returns_name_and_description(skills_dir):
    result = list_skills(skills_dir)
    assert len(result) == 1
    assert result[0]["name"] == "analyze-data"
    assert result[0]["description"] == "Analyze data with DuckDB"
    assert "content" not in result[0]


def test_list_skills_empty_dir(tmp_path):
    result = list_skills(str(tmp_path))
    assert result == []


def test_get_skill_returns_full_content(skills_dir):
    result = get_skill("analyze-data", skills_dir)
    assert result["name"] == "analyze-data"
    assert result["description"] == "Analyze data with DuckDB"
    assert "# Analyze Data" in result["content"]


def test_get_skill_not_found(skills_dir):
    result = get_skill("nonexistent", skills_dir)
    assert result is None


def test_create_skill_writes_file(tmp_path):
    skills_dir = str(tmp_path)
    create_skill("my-skill", "A test skill", "# My Skill\n\nDo things.", skills_dir)
    path = tmp_path / "my-skill" / "SKILL.md"
    assert path.exists()
    content = path.read_text()
    assert "name: my-skill" in content
    assert "description: A test skill" in content
    assert "# My Skill" in content


def test_create_skill_rejects_invalid_name(tmp_path):
    with pytest.raises(SkillValidationError, match="name"):
        create_skill("Invalid Name!", "desc", "content", str(tmp_path))


def test_create_skill_rejects_duplicate(skills_dir):
    with pytest.raises(SkillValidationError, match="exists"):
        create_skill("analyze-data", "desc", "content", skills_dir)


def test_update_skill_overwrites(skills_dir):
    update_skill("analyze-data", "Updated desc", "# Updated", skills_dir)
    result = get_skill("analyze-data", skills_dir)
    assert result["description"] == "Updated desc"
    assert "# Updated" in result["content"]


def test_update_skill_not_found(tmp_path):
    with pytest.raises(SkillValidationError, match="not found"):
        update_skill("nonexistent", "desc", "content", str(tmp_path))


def test_delete_skill_removes_directory(skills_dir):
    delete_skill("analyze-data", skills_dir)
    assert list_skills(skills_dir) == []


def test_delete_skill_not_found(tmp_path):
    with pytest.raises(SkillValidationError, match="not found"):
        delete_skill("nonexistent", str(tmp_path))


def test_get_skill_with_malformed_frontmatter(tmp_path):
    skill_dir = tmp_path / "broken"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text("---\nname: broken\nno closing delimiter")
    result = get_skill("broken", str(tmp_path))
    assert result is not None
    assert result["content"] != ""
