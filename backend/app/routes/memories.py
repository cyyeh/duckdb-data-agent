from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.agent_memory import read_memories, forget_memory

router = APIRouter(prefix="/api", tags=["memories"])


class DeleteMemoryRequest(BaseModel):
    content: str


@router.get("/memories")
async def api_list_memories():
    raw = read_memories(user_id="default")
    entries = []
    current_category = "fact"
    category_map = {
        "## Preferences": "preference",
        "## Facts": "fact",
        "## Patterns": "pattern",
    }
    for line in raw.split("\n"):
        stripped = line.strip()
        if stripped in category_map:
            current_category = category_map[stripped]
        elif stripped.startswith("- "):
            entries.append({
                "category": current_category,
                "content": stripped[2:],
            })
    return {"entries": entries, "raw": raw}


@router.delete("/memories")
async def api_delete_memory(request: DeleteMemoryRequest):
    result = forget_memory(request.content, user_id="default")
    if result != "Memory forgotten.":
        return JSONResponse(status_code=404, content={"error": result})
    return {"status": "deleted"}
