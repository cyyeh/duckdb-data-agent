import logging

from app.config import (
    LANGFUSE_ENABLED,
    LANGFUSE_PUBLIC_KEY,
    LANGFUSE_SECRET_KEY,
    LANGFUSE_BASE_URL,
)

logger = logging.getLogger(__name__)

_langfuse_client = None


def _init_langfuse():
    """Initialize Langfuse client if configured."""
    global _langfuse_client
    if not LANGFUSE_ENABLED:
        logger.info("Langfuse not configured, tracing disabled")
        return

    try:
        from langfuse import Langfuse

        _langfuse_client = Langfuse(
            public_key=LANGFUSE_PUBLIC_KEY,
            secret_key=LANGFUSE_SECRET_KEY,
            base_url=LANGFUSE_BASE_URL,
        )
        if _langfuse_client.auth_check():
            logger.info("Langfuse connected successfully")
        else:
            logger.warning("Langfuse auth check failed, tracing disabled")
            _langfuse_client = None
    except Exception as e:
        logger.warning("Failed to initialize Langfuse: %s", e)
        _langfuse_client = None


def get_langfuse_client():
    """Return the Langfuse client or None if not configured."""
    return _langfuse_client


def get_langfuse_dashboard_url() -> str | None:
    """Return the Langfuse dashboard base URL or None."""
    if _langfuse_client is None:
        return None
    return LANGFUSE_BASE_URL


# Initialize on module import
_init_langfuse()
