"""Kubernetes-based sandbox backend.

Wraps the ``k8s-agent-sandbox`` SDK to manage per-session sidecar pods,
implementing the ``SandboxBackend`` ABC so the rest of the application
is decoupled from the container orchestrator.
"""

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from app.sandbox.base import SandboxBackend, SandboxInfo

logger = logging.getLogger(__name__)

# The k8s-agent-sandbox package may not be installed in every environment.
# Guard the import so the module can still be loaded (e.g. for tests or
# when running in Docker-only mode).
try:
    from k8s_agent_sandbox import SandboxClient
except ImportError:
    SandboxClient = None  # type: ignore[assignment,misc]


@dataclass
class K8sConfig:
    template_name: str = "duckdb-agent-sidecar"
    namespace: str = "default"
    gateway_name: str = ""  # empty = tunnel/dev mode
    server_port: int = 3000
    max_lifetime_seconds: int = 3600
    idle_timeout_seconds: int = 300


async def _resolve_endpoint(client: object, port: int) -> str:
    """Resolve the sandbox endpoint URL from a SandboxClient.

    This is kept as a module-level function so tests can easily patch it
    without reaching into the backend instance.  The exact attribute used
    on ``client`` is implementation-defined; keeping it here makes future
    SDK changes a single-point edit.
    """
    host = client.host  # type: ignore[attr-defined]
    return f"http://{host}:{port}"


class K8sBackend(SandboxBackend):
    """Manages per-session sidecar pods on Kubernetes."""

    def __init__(self, config: K8sConfig | None = None):
        self._config = config or K8sConfig()
        self._sandboxes: dict[str, SandboxInfo] = {}
        self._clients: dict[str, object] = {}  # SandboxClient instances
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Public API (SandboxBackend interface)
    # ------------------------------------------------------------------

    async def create(self, session_id: str, env: dict[str, str]) -> SandboxInfo:
        if SandboxClient is None:
            raise RuntimeError(
                "k8s-agent-sandbox is not installed. "
                "Install it with: pip install k8s-agent-sandbox"
            )

        async with self._lock:
            # Return existing sandbox if already tracked
            if session_id in self._sandboxes:
                return self._sandboxes[session_id]

            # Build SandboxClient kwargs
            kwargs: dict = {
                "template_name": self._config.template_name,
                "namespace": self._config.namespace,
                "server_port": self._config.server_port,
            }
            if self._config.gateway_name:
                kwargs["gateway_name"] = self._config.gateway_name

            client = SandboxClient(**kwargs)
            await client.__aenter__()

            url = await _resolve_endpoint(client, self._config.server_port)

            info = SandboxInfo(
                sandbox_id=session_id,  # pod name derived from session
                session_id=session_id,
                url=url,
            )
            self._sandboxes[session_id] = info
            self._clients[session_id] = client

            logger.info(
                "Created K8s sandbox for session %s at %s",
                session_id,
                url,
            )
            return info

    def get(self, session_id: str) -> SandboxInfo | None:
        return self._sandboxes.get(session_id)

    def touch(self, session_id: str) -> None:
        info = self._sandboxes.get(session_id)
        if info is not None:
            info.last_activity = datetime.now(timezone.utc)

    async def stop(self, session_id: str) -> None:
        async with self._lock:
            info = self._sandboxes.pop(session_id, None)
            client = self._clients.pop(session_id, None)
            if info is None or client is None:
                return

            try:
                await client.__aexit__(None, None, None)  # type: ignore[union-attr]
            except Exception as exc:
                logger.warning(
                    "Failed to destroy K8s sandbox for session %s: %s",
                    session_id,
                    exc,
                )

            logger.info("Stopped K8s sandbox for session %s", session_id)

    async def cleanup_expired(self) -> int:
        async with self._lock:
            now = datetime.now(timezone.utc)
            idle_cutoff = now - timedelta(seconds=self._config.idle_timeout_seconds)
            lifetime_cutoff = now - timedelta(
                seconds=self._config.max_lifetime_seconds
            )

            expired = [
                sid
                for sid, info in self._sandboxes.items()
                if info.last_activity < idle_cutoff
                or info.created_at < lifetime_cutoff
            ]

        # Stop outside the identification loop to avoid dict-size-change errors,
        # but stop() itself acquires the lock so we must release first.
        for sid in expired:
            logger.info(
                "K8s sandbox for session %s expired (idle or max lifetime), removing",
                sid,
            )
            await self.stop(sid)

        return len(expired)

    async def shutdown_all(self) -> None:
        async with self._lock:
            session_ids = list(self._sandboxes.keys())

        for sid in session_ids:
            await self.stop(sid)

        logger.info("Shut down %d K8s sandboxes", len(session_ids))

    async def cleanup_orphaned(self) -> int:
        # Kubernetes controller handles orphan cleanup via ownerReferences.
        return 0
