import os
from dotenv import load_dotenv

load_dotenv()

BIFROST_BASE_URL = os.getenv("BIFROST_BASE_URL", "http://bifrost:8080")
BACKEND_BASE_URL = os.getenv("BACKEND_BASE_URL", "http://duckdb-data-agent:10000")
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-6")
SQL_SUBAGENT_MODEL = os.getenv("SQL_SUBAGENT_MODEL", "haiku")
CHART_SUBAGENT_MODEL = os.getenv("CHART_SUBAGENT_MODEL", "haiku")

LANGFUSE_PUBLIC_KEY = os.getenv("LANGFUSE_PUBLIC_KEY", "")
LANGFUSE_SECRET_KEY = os.getenv("LANGFUSE_SECRET_KEY", "")
LANGFUSE_BASE_URL = os.getenv("LANGFUSE_BASE_URL", "https://cloud.langfuse.com")
LANGFUSE_ENABLED = bool(LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY)

PROJECT_DIR = os.getenv("PROJECT_DIR", os.getcwd())
MAX_TOTAL_SIZE_BYTES = int(os.getenv("MAX_TOTAL_SIZE_BYTES", str(500 * 1024 * 1024)))  # default 500MB

# Container isolation settings
CONTAINER_IMAGE = os.getenv("CONTAINER_IMAGE", "duckdb-agent-sidecar:latest")
CONTAINER_RUNTIME = os.getenv("CONTAINER_RUNTIME", "runc")
CONTAINER_MEMORY_LIMIT = os.getenv("CONTAINER_MEMORY_LIMIT", "512m")
CONTAINER_CPU_LIMIT = float(os.getenv("CONTAINER_CPU_LIMIT", "0.5"))
CONTAINER_MAX_LIFETIME_SECONDS = int(os.getenv("CONTAINER_MAX_LIFETIME_SECONDS", "600"))
CONTAINER_NETWORK = os.getenv("CONTAINER_NETWORK", "agent-sandbox")
# CORS: comma-separated list of allowed origins, or "*" for all (no credentials).
# In production set to your actual frontend origin, e.g. "https://myapp.example.com".
CORS_ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv("CORS_ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:8000").split(",")
    if o.strip()
]
