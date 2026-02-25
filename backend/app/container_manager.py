import logging
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import docker

logger = logging.getLogger(__name__)


@dataclass
class ContainerConfig:
    image: str = "duckdb-agent-sidecar:latest"
    runtime: str = "runsc"
    memory_limit: str = "256m"
    cpu_limit: float = 0.5
    max_lifetime_seconds: int = 600
    network: str = "agent-sandbox"


@dataclass
class ContainerInfo:
    container_id: str
    session_id: str
    ip_address: str
    port: int = 3000
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    _container: object = field(default=None, repr=False)

    host_port: int | None = None

    @property
    def url(self) -> str:
        # Use the published host port only when running natively on macOS.
        # On macOS, Docker containers are in a VM and their bridge IPs are
        # not routable from the host, so we must go via the published port.
        # When the backend itself runs inside a container (docker-compose) or
        # on Linux, both containers share the same network and the direct
        # container IP is reachable — 127.0.0.1 would point at the backend
        # container itself, not the host.
        _on_macos_host = sys.platform == "darwin" and not os.path.exists("/.dockerenv")
        if self.host_port and _on_macos_host:
            return f"http://127.0.0.1:{self.host_port}"
        return f"http://{self.ip_address}:{self.port}"


class ContainerManager:
    """Manages per-session gVisor-sandboxed sidecar containers."""

    def __init__(self, config: ContainerConfig | None = None):
        self._config = config or ContainerConfig()
        self._client = docker.from_env()
        self._containers: dict[str, ContainerInfo] = {}

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
        from the sidecar network's IPAM config — this is the host-side bridge
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

    def create(self, session_id: str, env: dict[str, str]) -> ContainerInfo:
        """Spin up a new sidecar container for a session."""
        if session_id in self._containers:
            return self._containers[session_id]

        # Resolve container hostnames to IPs for gVisor DNS compatibility
        extra_hosts = self._resolve_network_hosts()
        # Resolve the actual gateway IP of the sidecar network so that
        # host.docker.internal points to the correct host-side bridge address.
        # Using "host-gateway" is unreliable under gVisor: it resolves to the
        # docker0 bridge IP which is on a different subnet from agent-sandbox,
        # so there is no route to it from inside the sidecar container.
        host_gateway_ip = self._resolve_host_gateway_ip()
        if host_gateway_ip:
            extra_hosts["host.docker.internal"] = host_gateway_ip
        else:
            # Fall back to Docker's magic value for non-Linux or Docker Desktop
            extra_hosts["host.docker.internal"] = "host-gateway"
            logger.warning(
                "Could not resolve host gateway IP from IPAM; falling back to "
                "host-gateway magic value (may not work under gVisor on Linux)"
            )
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
            tmpfs={"/tmp": "size=50m", "/home/appuser": "size=50m,uid=1000,gid=1000"},
            network=self._config.network,
            environment=env,
            extra_hosts=extra_hosts or None,
            # Use public DNS so gVisor's netstack can resolve external hosts
            # (Docker's embedded DNS at 127.0.0.11 doesn't work under runsc)
            dns=["8.8.8.8", "8.8.4.4"],
            # Publish port to a random host port so the host-side backend
            # can reach the sidecar (macOS cannot route to bridge IPs)
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

        info = ContainerInfo(
            container_id=container.id,
            session_id=session_id,
            ip_address=ip_address,
            host_port=host_port,
            _container=container,
        )
        self._containers[session_id] = info
        logger.info(
            "Created sidecar container %s for session %s at %s",
            container.id[:12],
            session_id,
            info.url,
        )
        return info

    def get(self, session_id: str) -> ContainerInfo | None:
        """Get container info for a session."""
        return self._containers.get(session_id)

    def stop(self, session_id: str) -> None:
        """Stop and remove the container for a session."""
        info = self._containers.pop(session_id, None)
        if info is None:
            return

        container = info._container
        try:
            container.stop(timeout=5)
        except Exception as e:
            logger.warning("Failed to stop container %s: %s", info.container_id[:12], e)
        try:
            container.remove(force=True)
        except Exception as e:
            logger.warning("Failed to remove container %s: %s", info.container_id[:12], e)

        logger.info("Stopped sidecar container %s for session %s", info.container_id[:12], session_id)

    def cleanup_expired(self) -> int:
        """Remove containers that have exceeded max lifetime."""
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=self._config.max_lifetime_seconds)
        expired = [
            sid for sid, info in self._containers.items()
            if info.created_at < cutoff
        ]
        for sid in expired:
            logger.info("Container for session %s exceeded max lifetime, removing", sid)
            self.stop(sid)
        return len(expired)

    def shutdown_all(self) -> None:
        """Stop and remove all active containers. Called on backend shutdown."""
        session_ids = list(self._containers.keys())
        for sid in session_ids:
            self.stop(sid)
        logger.info("Shut down %d sidecar containers", len(session_ids))


try:
    from app.config import (
        CONTAINER_IMAGE,
        CONTAINER_RUNTIME,
        CONTAINER_MEMORY_LIMIT,
        CONTAINER_CPU_LIMIT,
        CONTAINER_MAX_LIFETIME_SECONDS,
        CONTAINER_NETWORK,
    )

    container_manager = ContainerManager(
        ContainerConfig(
            image=CONTAINER_IMAGE,
            runtime=CONTAINER_RUNTIME,
            memory_limit=CONTAINER_MEMORY_LIMIT,
            cpu_limit=CONTAINER_CPU_LIMIT,
            max_lifetime_seconds=CONTAINER_MAX_LIFETIME_SECONDS,
            network=CONTAINER_NETWORK,
        )
    )
except Exception as e:
    logger.error("Failed to create container manager: %s", e)
    container_manager = None  # type: ignore[assignment]
