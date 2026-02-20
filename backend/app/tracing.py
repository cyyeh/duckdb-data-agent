import logging
import os

from app.config import LANGFUSE_ENABLED, LANGFUSE_BASE_URL

logger = logging.getLogger(__name__)

_langfuse_client = None


def _init_langfuse():
    """Initialize Langfuse with OTel auto-instrumentation for Claude Agent SDK."""
    global _langfuse_client
    if not LANGFUSE_ENABLED:
        logger.info("Langfuse not configured, tracing disabled")
        return

    # Set OTel env vars so langsmith routes traces through Langfuse
    os.environ.setdefault("LANGSMITH_OTEL_ENABLED", "true")
    os.environ.setdefault("LANGSMITH_OTEL_ONLY", "true")
    os.environ.setdefault("LANGSMITH_TRACING", "true")

    try:
        from langfuse import get_client

        _langfuse_client = get_client()

        if _langfuse_client.auth_check():
            logger.info("Langfuse connected successfully")
        else:
            logger.warning("Langfuse auth check failed, tracing disabled")
            _langfuse_client = None
            return

        # Enable auto-instrumentation for Claude Agent SDK
        from langsmith.integrations.claude_agent_sdk import configure_claude_agent_sdk

        if configure_claude_agent_sdk():
            logger.info("Claude Agent SDK auto-instrumentation enabled")
        else:
            logger.warning(
                "Failed to configure Claude Agent SDK auto-instrumentation"
            )

    except Exception as e:
        logger.warning("Failed to initialize Langfuse: %s", e)
        _langfuse_client = None


def get_langfuse_client():
    """Return the Langfuse client or None if not configured."""
    return _langfuse_client


def get_langfuse_dashboard_url() -> str | None:
    """Return the Langfuse project traces URL or None."""
    if _langfuse_client is None:
        return None
    try:
        project_id = _langfuse_client._get_project_id()
        if project_id:
            return f"{LANGFUSE_BASE_URL}/project/{project_id}/traces"
    except Exception as e:
        logger.warning("Failed to get Langfuse project ID: %s", e)
    return LANGFUSE_BASE_URL


# Initialize on module import
_init_langfuse()
