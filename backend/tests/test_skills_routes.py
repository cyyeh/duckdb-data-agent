import os
import pytest
from unittest.mock import patch
from fastapi.testclient import TestClient
from app.main import app


@pytest.fixture
def client(tmp_path):
    with patch("app.routes.skills.SKILLS_DIR", str(tmp_path)):
        # Seed one skill
        skill_dir = tmp_path / "analyze-data"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text(
            "---\nname: analyze-data\ndescription: Analyze data\n---\n\n# Content"
        )
        yield TestClient(app)


def test_list_skills(client):
    resp = client.get("/api/skills")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["name"] == "analyze-data"


def test_get_skill(client):
    resp = client.get("/api/skills/analyze-data")
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "analyze-data"
    assert "# Content" in data["content"]


def test_get_skill_not_found(client):
    resp = client.get("/api/skills/nope")
    assert resp.status_code == 404


def test_create_skill(client):
    resp = client.post("/api/skills", json={
        "name": "new-skill",
        "description": "A new skill",
        "content": "# New\n\nDo stuff",
    })
    assert resp.status_code == 201
    assert resp.json()["name"] == "new-skill"


def test_create_skill_invalid_name(client):
    resp = client.post("/api/skills", json={
        "name": "INVALID",
        "description": "bad",
        "content": "x",
    })
    assert resp.status_code == 400


def test_update_skill(client):
    resp = client.put("/api/skills/analyze-data", json={
        "description": "Updated",
        "content": "# Updated",
    })
    assert resp.status_code == 200
    assert resp.json()["description"] == "Updated"


def test_delete_skill(client):
    resp = client.delete("/api/skills/analyze-data")
    assert resp.status_code == 200
    # Verify it's gone
    resp2 = client.get("/api/skills/analyze-data")
    assert resp2.status_code == 404
