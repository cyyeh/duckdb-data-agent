from fastapi import APIRouter

from app.config import MAX_TOTAL_SIZE_BYTES

router = APIRouter(prefix="/api", tags=["config"])


@router.get("/config")
async def get_config():
    return {
        "maxTotalSizeBytes": MAX_TOTAL_SIZE_BYTES,
    }
