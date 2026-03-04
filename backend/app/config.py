import os
from dotenv import load_dotenv

load_dotenv()

BIFROST_BASE_URL = os.getenv("BIFROST_BASE_URL", "http://bifrost:8080")
BACKEND_BASE_URL = os.getenv("BACKEND_BASE_URL", "http://duckdb-data-agent:10000")


def parse_model(value: str) -> tuple[str, str]:
    """Parse 'real_model@sdk_alias' -> (sdk_alias, real_model).

    If no '@', returns (value, value) for backwards compatibility.
    """
    if "@" in value:
        real, sdk = value.rsplit("@", 1)
        return sdk, real
    return value, value


def build_model_rewrites(pairs: list[tuple[str, str]]) -> dict[str, str]:
    """Build a rewrite map from (sdk_alias, real_model) pairs.

    Only includes entries where sdk != real (i.e. rewriting is needed).
    """
    return {sdk: real for sdk, real in pairs if sdk != real}


_raw_model = os.getenv("ORCHESTRATOR_MODEL", "claude-sonnet-4-6")
_raw_sql = os.getenv("SQL_SUBAGENT_MODEL", "inherit")

ORCHESTRATOR_MODEL_SDK, ORCHESTRATOR_MODEL_REAL = parse_model(_raw_model)
SQL_SUBAGENT_MODEL_SDK, SQL_SUBAGENT_MODEL_REAL = parse_model(_raw_sql)

MODEL_REWRITES = build_model_rewrites([
    (ORCHESTRATOR_MODEL_SDK, ORCHESTRATOR_MODEL_REAL),
    (SQL_SUBAGENT_MODEL_SDK, SQL_SUBAGENT_MODEL_REAL),
])

DEFAULT_TOOL_MODEL = parse_model(os.getenv("DEFAULT_TOOL_MODEL", ""))[1]

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
CONTAINER_MAX_LIFETIME_SECONDS = int(os.getenv("CONTAINER_MAX_LIFETIME_SECONDS", "3600"))
CONTAINER_IDLE_TIMEOUT_SECONDS = int(os.getenv("CONTAINER_IDLE_TIMEOUT_SECONDS", "900"))
CONTAINER_NETWORK = os.getenv("CONTAINER_NETWORK", "agent-sandbox")
SDK_IDLE_TIMEOUT_MS = int(os.getenv("SDK_IDLE_TIMEOUT_MS", "600000"))
# OpenSandbox settings
SANDBOX_RUNTIME = os.getenv("SANDBOX_RUNTIME", "docker")  # "docker" or "kubernetes"
OPENSANDBOX_DOMAIN = os.getenv("OPENSANDBOX_DOMAIN", "localhost:8080")
OPENSANDBOX_API_KEY = os.getenv("OPENSANDBOX_API_KEY", "")
# Kubernetes-specific
K8S_NAMESPACE = os.getenv("K8S_NAMESPACE", "default")
K8S_WORKLOAD_PROVIDER = os.getenv("K8S_WORKLOAD_PROVIDER", "agent-sandbox")
MEMORY_DB_PATH = os.getenv("MEMORY_DB_PATH", os.path.join(PROJECT_DIR, "data", "memory.db"))
MEMORIES_DIR = os.getenv("MEMORIES_DIR", os.path.join(PROJECT_DIR, "data", "memories"))
# CORS: comma-separated list of allowed origins, or "*" for all (no credentials).
# In production set to your actual frontend origin, e.g. "https://myapp.example.com".
CORS_ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv("CORS_ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:8000").split(",")
    if o.strip()
]
