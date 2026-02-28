import os
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.skills import list_skills, get_skill, create_skill, update_skill, delete_skill, toggle_skill_disabled, SkillValidationError

router = APIRouter(prefix="/api", tags=["skills"])

# Skills live at skills/ relative to the project root.
# In Docker, the backend runs from /app, and the skills directory is
# mounted at a path configured via SKILLS_DIR env var.
SKILLS_DIR = os.environ.get("SKILLS_DIR", os.path.join(os.path.dirname(__file__), "..", "..", "..", "skills"))


class CreateSkillRequest(BaseModel):
    name: str
    description: str
    content: str


class UpdateSkillRequest(BaseModel):
    description: str
    content: str


class ToggleSkillRequest(BaseModel):
    disabled: bool


@router.get("/skills")
async def api_list_skills():
    return list_skills(SKILLS_DIR)


@router.get("/skills/{name}")
async def api_get_skill(name: str):
    skill = get_skill(name, SKILLS_DIR)
    if skill is None:
        return JSONResponse(status_code=404, content={"error": f"Skill '{name}' not found"})
    return skill


@router.post("/skills", status_code=201)
async def api_create_skill(request: CreateSkillRequest):
    try:
        create_skill(request.name, request.description, request.content, SKILLS_DIR)
    except SkillValidationError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    return get_skill(request.name, SKILLS_DIR)


@router.put("/skills/{name}")
async def api_update_skill(name: str, request: UpdateSkillRequest):
    try:
        update_skill(name, request.description, request.content, SKILLS_DIR)
    except SkillValidationError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    return get_skill(name, SKILLS_DIR)


@router.delete("/skills/{name}")
async def api_delete_skill(name: str):
    try:
        delete_skill(name, SKILLS_DIR)
    except SkillValidationError as e:
        status = 403 if "built-in" in str(e) else 400
        return JSONResponse(status_code=status, content={"error": str(e)})
    return {"status": "deleted"}


@router.patch("/skills/{name}/toggle")
async def api_toggle_skill(name: str, request: ToggleSkillRequest):
    try:
        updated = toggle_skill_disabled(name, request.disabled, SKILLS_DIR)
    except SkillValidationError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    return updated
