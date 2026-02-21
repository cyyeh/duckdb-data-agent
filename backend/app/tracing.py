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

    # Set OTel env vars so langsmith routes traces through Langfuse.
    # Must be set before any langsmith import to avoid LRU cache issues.
    for key, val in {
        "LANGSMITH_OTEL_ENABLED": "true",
        "LANGSMITH_OTEL_ONLY": "true",
        "LANGSMITH_TRACING": "true",
    }.items():
        os.environ.setdefault(key, val)

    try:
        from langfuse import get_client

        _langfuse_client = get_client()

        # Scrub Langfuse credentials from os.environ so they cannot leak
        # to agent subprocesses via environment inheritance.  The client
        # object already holds the credentials internally.
        for _key in ("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"):
            os.environ.pop(_key, None)

        if _langfuse_client.auth_check():
            logger.info("Langfuse connected successfully")
        else:
            logger.warning("Langfuse auth check failed, tracing disabled")
            _langfuse_client = None
            return

        # Suppress harmless warnings from langsmith/OTel integration BEFORE
        # creating Client (background thread starts during Client.__init__):
        # 1. "Run compression is not enabled" — race condition: thread starts
        #    before otel_exporter is assigned. Batch processing uses env vars.
        # 2. "Invalid type dict for attribute" — langsmith sets usage_metadata
        #    as a dict, but OTel only accepts primitive types.
        logging.getLogger("langsmith.client").setLevel(logging.ERROR)
        logging.getLogger("opentelemetry.attributes").setLevel(logging.ERROR)

        # Pre-create the global LangSmith Client with otel_enabled=True
        # so the background tracing thread knows to use OTel-only mode.
        from langsmith.client import Client
        from langsmith.run_trees import configure

        configure(client=Client(otel_enabled=True))

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
