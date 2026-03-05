"""Docker-based sandbox backend.

Wraps the Docker SDK to manage per-session gVisor-sandboxed sidecar
containers, implementing the ``SandboxBackend`` ABC so the rest of
the application is decoupled from the container runtime.
"""

import asyncio
import logging
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import docker

from app.sandbox.base import SandboxBackend, SandboxInfo

logger = logging.getLogger(__name__)


@dataclass
class DockerConfig:
    image: str = "duckdb-agent-sidecar:latest"
    runtime: str = "runsc"
    memory_limit: str = "256m"
    cpu_limit: float = 0.5
    max_lifetime_seconds: int = 3600
    idle_timeout_seconds: int = 300
    network: str = "agent-sandbox"


@dataclass
class _DockerContainerState:
    """Internal state holding the Docker container object reference."""

    container: object  # docker.models.containers.Container


class DockerBackend(SandboxBackend):
    """Manages per-session gVisor-sandboxed sidecar containers via Docker."""

    def __init__(self, config: DockerConfig | None = None):
        self._config = config or DockerConfig()
        self._client = docker.from_env()
        self._sandboxes: dict[str, SandboxInfo] = {}
        self._docker_state: dict[str, _DockerContainerState] = {}

    # ------------------------------------------------------------------
    # Private helpers (sync — called from within executor-wrapped code)
    # ------------------------------------------------------------------

    def _resolve_network_hosts(self) -> dict[str, str]:
        """Resolve container hostnames to IPs on the sidecar network.

        gVisor's netstack doesn't use Docker's embedded DNS (127.0.0.11),
        so DNS resolution fails inside runsc containers. We build an
        extra_hosts mapping from container names to their IPs on the
        shared network so /etc/hosts provides the resolution instead.
        """
        hosts: dict[str, str] = {}
        try:
            network = self._client.networks.get(self._config.network)
            network.reload()
            containers = network.attrs.get("Containers", {})
            for _cid, info in containers.items():
                name = info.get("Name", "")
                ipv4 = info.get("IPv4Address", "")
                if name and ipv4:
                    # Strip CIDR suffix (e.g. "172.20.0.2/16" -> "172.20.0.2")
                    ip = ipv4.split("/")[0]
                    hosts[name] = ip
        except Exception as e:
            logger.warning("Failed to resolve network hosts: %s", e)
        return hosts

    def _resolve_host_gateway_ip(self) -> str | None:
        """Get the host IP reachable from sidecar containers.

        Docker's "host-gateway" magic value resolves to the docker0 bridge IP,
        not to the gateway of our custom network. Under gVisor the value may
        also not be honoured at all. Instead we read the gateway IP directly
        from the sidecar network's IPAM config -- this is the host-side bridge
        address that containers on that network can actually route to.
        """
        try:
            network = self._client.networks.get(self._config.network)
            network.reload()
            for cfg in network.attrs.get("IPAM", {}).get("Config", []):
                gateway = cfg.get("Gateway")
                if gateway:
                    logger.info("Resolved host.docker.internal gateway to %s", gateway)
                    return gateway
        except Exception as e:
            logger.warning("Failed to resolve host gateway IP: %s", e)
        return None

    def _cleanup_by_label(self, *, exclude_ids: set[str] | None = None) -> int:
        """Stop and remove all Docker containers with the sidecar label.

        Args:
            exclude_ids: Container IDs to skip (already handled elsewhere).

        Returns the number of containers cleaned up.
        """
        skip = exclude_ids or set()
        cleaned = 0
        try:
            containers = self._client.containers.list(
                filters={"label": "app=duckdb-agent-sidecar"},
                all=True,
            )
        except Exception as e:
            logger.warning("Failed to list sidecar containers by label: %s", e)
            return 0

        for container in containers:
            if container.id in skip:
                continue  # already handled
            try:
                container.stop(timeout=5)
            except Exception as e:
                logger.warning(
                    "Failed to stop orphaned container %s: %s",
                    container.id[:12],
                    e,
                )
            try:
                container.remove(force=True)
            except Exception as e:
                logger.warning(
                    "Failed to remove orphaned container %s: %s",
                    container.id[:12],
                    e,
                )
            logger.info("Cleaned up orphaned sidecar container %s", container.id[:12])
            cleaned += 1
        return cleaned

    @staticmethod
    def _compute_url(ip_address: str, port: int, host_port: int | None) -> str:
        """Compute the sandbox URL using the same macOS host port logic."""
        _on_macos_host = sys.platform == "darwin" and not os.path.exists(
            "/.dockerenv"
        )
        if host_port and _on_macos_host:
            return f"http://127.0.0.1:{host_port}"
        return f"http://{ip_address}:{port}"

    def _sync_create(self, session_id: str, env: dict[str, str]) -> SandboxInfo:
        """Synchronous container creation — runs inside an executor."""

        # Skills volume
        skills_host_path = os.environ.get("SKILLS_HOST_PATH", "")
        if not skills_host_path:
            if not os.path.exists("/.dockerenv"):
                fallback = os.path.abspath(
                    os.path.join(os.path.dirname(__file__), "..", "..", "skills")
                )
                if os.path.isdir(fallback):
                    skills_host_path = fallback

        # Plugins volume
        plugins_host_path = os.environ.get("PLUGINS_HOST_PATH", "")
        if not plugins_host_path:
            if not os.path.exists("/.dockerenv"):
                fallback_plugins = os.path.abspath(
                    os.path.join(os.path.dirname(__file__), "..", "..", "plugins")
                )
                if os.path.isdir(fallback_plugins):
                    plugins_host_path = fallback_plugins

        volumes = {}
        if skills_host_path:
            abs_skills_path = os.path.abspath(skills_host_path)
            volumes[abs_skills_path] = {"bind": "/app/.claude/skills", "mode": "ro"}
        if plugins_host_path:
            abs_plugins_path = os.path.abspath(plugins_host_path)
            volumes[abs_plugins_path] = {"bind": "/app/plugins", "mode": "ro"}

        # Resolve container hostnames to IPs for gVisor DNS compatibility
        extra_hosts = self._resolve_network_hosts()

        # Resolve host.docker.internal
        _on_macos_host = sys.platform == "darwin" and not os.path.exists("/.dockerenv")
        _using_gvisor = self._config.runtime == "runsc"

        if _using_gvisor and not _on_macos_host:
            host_gateway_ip = self._resolve_host_gateway_ip()
            if host_gateway_ip:
                extra_hosts["host.docker.internal"] = host_gateway_ip
            else:
                extra_hosts["host.docker.internal"] = "host-gateway"
                logger.warning(
                    "Could not resolve host gateway IP from IPAM; falling back to "
                    "host-gateway magic value (may not work under gVisor on Linux)"
                )
        else:
            extra_hosts["host.docker.internal"] = "host-gateway"

        if extra_hosts:
            logger.info("Sidecar extra_hosts: %s", extra_hosts)

        container = self._client.containers.run(
            image=self._config.image,
            detach=True,
            runtime=self._config.runtime,
            mem_limit=self._config.memory_limit,
            nano_cpus=int(self._config.cpu_limit * 1e9),
            read_only=True,
            cap_drop=["ALL"],
            security_opt=["no-new-privileges"],
            tmpfs={
                "/tmp": "size=50m",
                "/home/appuser": "size=50m,uid=1000,gid=1000",
                "/home/appuser/.claude": "size=10m,uid=1000,gid=1000",
            },
            **({"volumes": volumes} if volumes else {}),
            network=self._config.network,
            environment=env,
            extra_hosts=extra_hosts or None,
            dns=["8.8.8.8", "8.8.4.4"],
            ports={"3000/tcp": None},
            labels={
                "app": "duckdb-agent-sidecar",
                "session_id": session_id,
            },
            auto_remove=False,
        )

        container.reload()
        networks = container.attrs.get("NetworkSettings", {}).get("Networks", {})
        network_info = networks.get(self._config.network, {})
        ip_address = network_info.get("IPAddress", "127.0.0.1")

        # Extract the dynamically assigned host port
        port_bindings = container.attrs.get("NetworkSettings", {}).get("Ports", {})
        host_port = None
        tcp_bindings = port_bindings.get("3000/tcp")
        if tcp_bindings and len(tcp_bindings) > 0:
            host_port = int(tcp_bindings[0].get("HostPort", 0)) or None

        url = self._compute_url(ip_address, 3000, host_port)

        info = SandboxInfo(
            sandbox_id=container.id,
            session_id=session_id,
            url=url,
        )
        self._sandboxes[session_id] = info
        self._docker_state[session_id] = _DockerContainerState(container=container)

        logger.info(
            "Created sidecar container %s for session %s at %s",
            container.id[:12],
            session_id,
            url,
        )
        return info

    def _sync_stop(self, session_id: str) -> None:
        """Synchronous container stop — runs inside an executor."""
        info = self._sandboxes.pop(session_id, None)
        state = self._docker_state.pop(session_id, None)
        if info is None or state is None:
            return

        container = state.container
        try:
            container.stop(timeout=5)
        except Exception as e:
            logger.warning(
                "Failed to stop container %s: %s", info.sandbox_id[:12], e
            )
        try:
            container.remove(force=True)
        except Exception as e:
            logger.warning(
                "Failed to remove container %s: %s", info.sandbox_id[:12], e
            )

        logger.info(
            "Stopped sidecar container %s for session %s",
            info.sandbox_id[:12],
            session_id,
        )

    def _sync_cleanup_expired(self) -> int:
        """Remove containers that are idle or have exceeded max lifetime."""
        now = datetime.now(timezone.utc)
        idle_cutoff = now - timedelta(seconds=self._config.idle_timeout_seconds)
        lifetime_cutoff = now - timedelta(seconds=self._config.max_lifetime_seconds)
        expired = [
            sid
            for sid, info in self._sandboxes.items()
            if info.last_activity < idle_cutoff or info.created_at < lifetime_cutoff
        ]
        for sid in expired:
            logger.info(
                "Container for session %s expired (idle or max lifetime), removing",
                sid,
            )
            self._sync_stop(sid)
        return len(expired)

    def _sync_shutdown_all(self) -> None:
        """Stop all tracked containers and clean up orphans by label."""
        # 1. Snapshot tracked IDs before stopping (stop pops from the dict).
        tracked_ids = {info.sandbox_id for info in self._sandboxes.values()}
        session_ids = list(self._sandboxes.keys())
        for sid in session_ids:
            self._sync_stop(sid)
        tracked_count = len(session_ids)

        # 2. Find any remaining sidecar containers via Docker labels.
        orphan_count = self._cleanup_by_label(exclude_ids=tracked_ids)

        logger.info(
            "Shut down %d tracked + %d orphaned sidecar containers",
            tracked_count,
            orphan_count,
        )

    # ------------------------------------------------------------------
    # Public API (SandboxBackend interface)
    # ------------------------------------------------------------------

    async def create(self, session_id: str, env: dict[str, str]) -> SandboxInfo:
        if session_id in self._sandboxes:
            return self._sandboxes[session_id]
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self._sync_create, session_id, env)

    def get(self, session_id: str) -> SandboxInfo | None:
        return self._sandboxes.get(session_id)

    def touch(self, session_id: str) -> None:
        info = self._sandboxes.get(session_id)
        if info is not None:
            info.last_activity = datetime.now(timezone.utc)

    async def stop(self, session_id: str) -> None:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self._sync_stop, session_id)

    async def cleanup_expired(self) -> int:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self._sync_cleanup_expired)

    async def shutdown_all(self) -> None:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self._sync_shutdown_all)

    async def cleanup_orphaned(self) -> int:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self._cleanup_by_label)
