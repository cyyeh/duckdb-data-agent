"""OpenSandbox-based container lifecycle management.

Replaces the direct Docker SDK ContainerManager with the OpenSandbox SDK.
Supports both Docker and Kubernetes runtimes via OpenSandbox server.
"""

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

try:
    from opensandbox import Sandbox, SandboxManager as OSManager
    from opensandbox.config import ConnectionConfig
    from opensandbox.models.sandboxes import SandboxFilter
except ImportError:
    # opensandbox not installed — define placeholders so the module can be
    # imported and the classes used in type hints / mocks during tests.
    Sandbox = None  # type: ignore[assignment,misc]
    OSManager = None  # type: ignore[assignment,misc]
    ConnectionConfig = None  # type: ignore[assignment,misc]
    SandboxFilter = None  # type: ignore[assignment,misc]

logger = logging.getLogger(__name__)


@dataclass
class SandboxConfig:
    image: str = "duckdb-agent-sidecar:latest"
    memory_limit: str = "512m"
    cpu_limit: float = 0.5
    max_lifetime_seconds: int = 3600
    idle_timeout_seconds: int = 300
    sidecar_port: int = 3000
    opensandbox_domain: str = "localhost:8080"
    opensandbox_api_key: str = ""

    def resource_dict(self) -> dict[str, str]:
        """Return resource limits in OpenSandbox format."""
        cpu_str = (
            str(int(self.cpu_limit))
            if self.cpu_limit == int(self.cpu_limit)
            else str(self.cpu_limit)
        )
        return {"cpu": cpu_str, "memory": self.memory_limit}


@dataclass
class SandboxInfo:
    sandbox_id: str
    session_id: str
    endpoint: str  # "host:port"
    endpoint_headers: dict[str, str] = field(default_factory=dict)
    port: int = 3000
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    last_activity: datetime = field(default=None)
    _sandbox: Any = field(default=None, repr=False)

    def __post_init__(self):
        if self.last_activity is None:
            self.last_activity = self.created_at

    @property
    def url(self) -> str:
        return f"http://{self.endpoint}"


class SandboxManager:
    """Manages per-session sidecar containers via OpenSandbox."""

    def __init__(self, config: SandboxConfig | None = None):
        self._config = config or SandboxConfig()
        if ConnectionConfig is not None:
            self._connection_config = ConnectionConfig(
                domain=self._config.opensandbox_domain,
                api_key=self._config.opensandbox_api_key or None,
                request_timeout=timedelta(seconds=60),
            )
        else:
            self._connection_config = None
        self._sandboxes: dict[str, SandboxInfo] = {}
        self._lock = asyncio.Lock()

    async def create(self, session_id: str, env: dict[str, str]) -> SandboxInfo:
        """Create a new sidecar sandbox for a session."""
        if Sandbox is None:
            raise RuntimeError(
                "opensandbox package is not installed. "
                "Install it with: pip install opensandbox"
            )

        async with self._lock:
            if session_id in self._sandboxes:
                return self._sandboxes[session_id]

            sandbox = await Sandbox.create(
                self._config.image,
                connection_config=self._connection_config,
                timeout=timedelta(seconds=self._config.max_lifetime_seconds),
                env=env,
                metadata={
                    "app": "duckdb-agent-sidecar",
                    "session_id": session_id,
                },
                resource=self._config.resource_dict(),
                entrypoint=["node", "dist/server.js"],
                skip_health_check=True,
            )

            endpoint = await sandbox.get_endpoint(self._config.sidecar_port)

            info = SandboxInfo(
                sandbox_id=sandbox.id,
                session_id=session_id,
                endpoint=endpoint.endpoint,
                endpoint_headers=endpoint.headers or {},
                port=self._config.sidecar_port,
                _sandbox=sandbox,
            )
            self._sandboxes[session_id] = info
            logger.info(
                "Created sandbox %s for session %s at %s",
                sandbox.id[:12],
                session_id,
                info.url,
            )
            return info

    def get(self, session_id: str) -> SandboxInfo | None:
        """Get sandbox info for a session."""
        return self._sandboxes.get(session_id)

    def touch(self, session_id: str) -> None:
        """Update last_activity timestamp for a session's sandbox."""
        info = self._sandboxes.get(session_id)
        if info is not None:
            info.last_activity = datetime.now(timezone.utc)

    async def _stop_unlocked(
        self, session_id: str, *, timeout: float = 10
    ) -> None:
        """Kill and remove the sandbox for a session (caller must hold lock)."""
        info = self._sandboxes.pop(session_id, None)
        if info is None:
            return

        sandbox = info._sandbox
        try:
            await asyncio.wait_for(sandbox.kill(), timeout=timeout)
        except asyncio.TimeoutError:
            logger.warning(
                "Timed out killing sandbox %s (%.0fs)", info.sandbox_id[:12], timeout
            )
        except Exception as e:
            logger.warning(
                "Failed to kill sandbox %s: %s", info.sandbox_id[:12], e
            )
        else:
            logger.info(
                "Stopped sandbox %s for session %s",
                info.sandbox_id[:12],
                session_id,
            )

    async def stop(self, session_id: str) -> None:
        """Kill and remove the sandbox for a session."""
        async with self._lock:
            await self._stop_unlocked(session_id)

    async def cleanup_expired(self) -> int:
        """Remove sandboxes that are idle or have exceeded max lifetime."""
        async with self._lock:
            now = datetime.now(timezone.utc)
            idle_cutoff = now - timedelta(seconds=self._config.idle_timeout_seconds)
            lifetime_cutoff = now - timedelta(seconds=self._config.max_lifetime_seconds)
            expired = [
                sid
                for sid, info in self._sandboxes.items()
                if info.last_activity < idle_cutoff or info.created_at < lifetime_cutoff
            ]
            for sid in expired:
                logger.info("Sandbox for session %s expired, removing", sid)
                await self._stop_unlocked(sid)
            return len(expired)

    async def shutdown_all(self) -> None:
        """Kill all tracked sandboxes. Called on backend shutdown."""
        async with self._lock:
            session_ids = list(self._sandboxes.keys())
            if not session_ids:
                return

            # Suppress noisy ERROR tracebacks from the opensandbox library
            # during shutdown — connection failures are expected when the
            # OpenSandbox server is shutting down at the same time.
            os_logger = logging.getLogger("opensandbox")
            prev_level = os_logger.level
            os_logger.setLevel(logging.CRITICAL)
            try:
                for sid in session_ids:
                    await self._stop_unlocked(sid, timeout=5)
            finally:
                os_logger.setLevel(prev_level)

            logger.info("Shut down %d sandboxes", len(session_ids))

    async def cleanup_orphaned(self) -> int:
        """Find and kill orphaned sandboxes from previous runs."""
        if OSManager is None:
            logger.warning("opensandbox not installed, skipping orphan cleanup")
            return 0
        try:
            async with await OSManager.create(
                connection_config=self._connection_config
            ) as mgr:
                result = await mgr.list_sandbox_infos(
                    SandboxFilter(
                        metadata={"app": "duckdb-agent-sidecar"},
                        states=["RUNNING"],
                    )
                )
                tracked_ids = {
                    info.sandbox_id for info in self._sandboxes.values()
                }
                orphans = 0
                for sb_info in result.sandbox_infos:
                    if sb_info.id not in tracked_ids:
                        try:
                            await mgr.kill_sandbox(sb_info.id)
                            logger.info(
                                "Cleaned up orphaned sandbox %s", sb_info.id[:12]
                            )
                            orphans += 1
                        except Exception as e:
                            logger.warning(
                                "Failed to kill orphaned sandbox %s: %s",
                                sb_info.id[:12],
                                e,
                            )
                return orphans
        except Exception as e:
            logger.warning("Failed to list orphaned sandboxes: %s", e)
            return 0


# --- Module-level singleton ---

try:
    from app.config import (
        CONTAINER_IMAGE,
        CONTAINER_MEMORY_LIMIT,
        CONTAINER_CPU_LIMIT,
        CONTAINER_MAX_LIFETIME_SECONDS,
        CONTAINER_IDLE_TIMEOUT_SECONDS,
        OPENSANDBOX_DOMAIN,
        OPENSANDBOX_API_KEY,
    )

    sandbox_manager = SandboxManager(
        SandboxConfig(
            image=CONTAINER_IMAGE,
            memory_limit=CONTAINER_MEMORY_LIMIT,
            cpu_limit=CONTAINER_CPU_LIMIT,
            max_lifetime_seconds=CONTAINER_MAX_LIFETIME_SECONDS,
            idle_timeout_seconds=CONTAINER_IDLE_TIMEOUT_SECONDS,
            opensandbox_domain=OPENSANDBOX_DOMAIN,
            opensandbox_api_key=OPENSANDBOX_API_KEY,
        )
    )
except Exception as e:
    logger.error("Failed to create sandbox manager: %s", e)
    sandbox_manager = None  # type: ignore[assignment]
