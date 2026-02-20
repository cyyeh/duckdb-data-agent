from fastapi import APIRouter

from app.tracing import get_langfuse_client, get_langfuse_dashboard_url

router = APIRouter(prefix="/api", tags=["langfuse"])


@router.get("/langfuse/status")
async def langfuse_status():
    return {
        "enabled": get_langfuse_client() is not None,
        "dashboardUrl": get_langfuse_dashboard_url(),
    }
