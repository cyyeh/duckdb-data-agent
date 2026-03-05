import asyncio
import time
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest

from app.sandbox.base import SandboxBackend, SandboxInfo
from app.sandbox.docker_backend import DockerBackend, DockerConfig


def run(coro):
    """Run an async coroutine to completion (test helper)."""
    loop = asyncio.get_event_loop()
    return loop.run_until_complete(coro)


# ------------------------------------------------------------------
# Fixtures
# ------------------------------------------------------------------


@pytest.fixture
def config():
    return DockerConfig(
        image="duckdb-agent-sidecar:latest",
        runtime="runsc",
        memory_limit="256m",
        cpu_limit=0.5,
        max_lifetime_seconds=600,
        idle_timeout_seconds=300,
        network="agent-sandbox",
    )


@pytest.fixture
def mock_docker_client():
    client = MagicMock()
    client.containers = MagicMock()
    client.networks = MagicMock()
    return client


@pytest.fixture
def backend(config, mock_docker_client):
    with patch("app.sandbox.docker_backend.docker") as mock_docker:
        mock_docker.from_env.return_value = mock_docker_client
        be = DockerBackend(config)
        be._client = mock_docker_client
        return be


def _make_mock_container(
    container_id="abc123",
    ip_address="172.18.0.2",
    network="agent-sandbox",
    host_port=None,
):
    """Create a mock Docker container with standard attrs."""
    container = MagicMock()
    container.id = container_id

    ports = {}
    if host_port is not None:
        ports["3000/tcp"] = [{"HostPort": str(host_port)}]

    container.attrs = {
        "NetworkSettings": {
            "Networks": {network: {"IPAddress": ip_address}},
            "Ports": ports,
        }
    }
    return container


# ------------------------------------------------------------------
# DockerConfig tests
# ------------------------------------------------------------------


def test_docker_config_has_defaults():
    cfg = DockerConfig()
    assert cfg.image == "duckdb-agent-sidecar:latest"
    assert cfg.runtime == "runsc"
    assert cfg.memory_limit == "256m"
    assert cfg.cpu_limit == 0.5
    assert cfg.max_lifetime_seconds == 3600
    assert cfg.idle_timeout_seconds == 300
    assert cfg.network == "agent-sandbox"


def test_docker_config_custom_values():
    cfg = DockerConfig(
        image="custom:v2",
        runtime="runc",
        memory_limit="512m",
        cpu_limit=1.0,
        max_lifetime_seconds=7200,
        idle_timeout_seconds=600,
        network="custom-net",
    )
    assert cfg.image == "custom:v2"
    assert cfg.runtime == "runc"
    assert cfg.memory_limit == "512m"
    assert cfg.cpu_limit == 1.0
    assert cfg.max_lifetime_seconds == 7200
    assert cfg.idle_timeout_seconds == 600
    assert cfg.network == "custom-net"


# ------------------------------------------------------------------
# DockerBackend implements SandboxBackend
# ------------------------------------------------------------------


def test_docker_backend_is_sandbox_backend(backend):
    assert isinstance(backend, SandboxBackend)


# ------------------------------------------------------------------
# create()
# ------------------------------------------------------------------


def test_create_stores_sandbox_info(backend, mock_docker_client):
    mock_container = _make_mock_container()
    mock_docker_client.containers.run.return_value = mock_container

    info = run(backend.create("session-1", {"ANTHROPIC_API_KEY": "token123"}))

    assert "session-1" in backend._sandboxes
    assert isinstance(info, SandboxInfo)
    assert info.sandbox_id == "abc123"
    assert info.session_id == "session-1"


def test_create_returns_existing_for_same_session(backend, mock_docker_client):
    mock_container = _make_mock_container()
    mock_docker_client.containers.run.return_value = mock_container

    info1 = run(backend.create("session-1", {}))
    info2 = run(backend.create("session-1", {}))

    assert info1 is info2
    # Docker SDK should only be called once
    mock_docker_client.containers.run.assert_called_once()


def test_create_passes_security_flags(backend, mock_docker_client):
    mock_container = _make_mock_container()
    mock_docker_client.containers.run.return_value = mock_container

    run(backend.create("session-1", {"ANTHROPIC_API_KEY": "token123"}))

    call_kwargs = mock_docker_client.containers.run.call_args[1]
    assert call_kwargs["runtime"] == "runsc"
    assert call_kwargs["read_only"] is True
    assert call_kwargs["cap_drop"] == ["ALL"]
    assert call_kwargs["security_opt"] == ["no-new-privileges"]
    assert call_kwargs["detach"] is True


def test_create_passes_resource_limits(backend, mock_docker_client):
    mock_container = _make_mock_container()
    mock_docker_client.containers.run.return_value = mock_container

    run(backend.create("session-1", {}))

    call_kwargs = mock_docker_client.containers.run.call_args[1]
    assert call_kwargs["mem_limit"] == "256m"
    assert call_kwargs["nano_cpus"] == int(0.5 * 1e9)


def test_create_passes_dns_and_labels(backend, mock_docker_client):
    mock_container = _make_mock_container()
    mock_docker_client.containers.run.return_value = mock_container

    run(backend.create("session-1", {}))

    call_kwargs = mock_docker_client.containers.run.call_args[1]
    assert call_kwargs["dns"] == ["8.8.8.8", "8.8.4.4"]
    assert call_kwargs["labels"]["app"] == "duckdb-agent-sidecar"
    assert call_kwargs["labels"]["session_id"] == "session-1"


def test_create_passes_environment(backend, mock_docker_client):
    mock_container = _make_mock_container()
    mock_docker_client.containers.run.return_value = mock_container

    env = {"ANTHROPIC_API_KEY": "key123", "FOO": "bar"}
    run(backend.create("session-1", env))

    call_kwargs = mock_docker_client.containers.run.call_args[1]
    assert call_kwargs["environment"] == env


def test_create_passes_network_and_port(backend, mock_docker_client):
    mock_container = _make_mock_container()
    mock_docker_client.containers.run.return_value = mock_container

    run(backend.create("session-1", {}))

    call_kwargs = mock_docker_client.containers.run.call_args[1]
    assert call_kwargs["network"] == "agent-sandbox"
    assert call_kwargs["ports"] == {"3000/tcp": None}


def test_create_passes_tmpfs(backend, mock_docker_client):
    mock_container = _make_mock_container()
    mock_docker_client.containers.run.return_value = mock_container

    run(backend.create("session-1", {}))

    call_kwargs = mock_docker_client.containers.run.call_args[1]
    assert "/tmp" in call_kwargs["tmpfs"]
    assert "/home/appuser" in call_kwargs["tmpfs"]
    assert "/home/appuser/.claude" in call_kwargs["tmpfs"]


def test_create_stores_docker_state(backend, mock_docker_client):
    mock_container = _make_mock_container()
    mock_docker_client.containers.run.return_value = mock_container

    run(backend.create("session-1", {}))

    assert "session-1" in backend._docker_state
    assert backend._docker_state["session-1"].container is mock_container


# ------------------------------------------------------------------
# URL computation
# ------------------------------------------------------------------


def test_url_uses_ip_address(backend, mock_docker_client):
    mock_container = _make_mock_container(ip_address="172.18.0.5")
    mock_docker_client.containers.run.return_value = mock_container

    info = run(backend.create("session-1", {}))
    # When not on macOS host or no host_port, URL uses container IP
    assert "172.18.0.5:3000" in info.url


def test_compute_url_uses_host_port_on_macos():
    """On macOS host, URL should use 127.0.0.1 with the published host port."""
    with patch("app.sandbox.docker_backend.sys") as mock_sys, \
         patch("app.sandbox.docker_backend.os.path.exists", return_value=False):
        mock_sys.platform = "darwin"
        url = DockerBackend._compute_url("172.18.0.2", 3000, 32768)
        assert url == "http://127.0.0.1:32768"


def test_compute_url_uses_ip_when_not_macos():
    """On Linux or in Docker, URL uses the container IP."""
    with patch("app.sandbox.docker_backend.sys") as mock_sys:
        mock_sys.platform = "linux"
        url = DockerBackend._compute_url("172.18.0.2", 3000, 32768)
        assert url == "http://172.18.0.2:3000"


def test_compute_url_uses_ip_when_no_host_port():
    """Even on macOS, if no host_port is available, fall back to container IP."""
    with patch("app.sandbox.docker_backend.sys") as mock_sys, \
         patch("app.sandbox.docker_backend.os.path.exists", return_value=False):
        mock_sys.platform = "darwin"
        url = DockerBackend._compute_url("172.18.0.2", 3000, None)
        assert url == "http://172.18.0.2:3000"


# ------------------------------------------------------------------
# get()
# ------------------------------------------------------------------


def test_get_returns_sandbox_info(backend, mock_docker_client):
    mock_container = _make_mock_container()
    mock_docker_client.containers.run.return_value = mock_container

    run(backend.create("session-1", {}))
    info = backend.get("session-1")

    assert info is not None
    assert info.session_id == "session-1"


def test_get_returns_none_for_unknown_session(backend):
    assert backend.get("unknown") is None


# ------------------------------------------------------------------
# touch()
# ------------------------------------------------------------------


def test_touch_updates_last_activity(backend, mock_docker_client):
    mock_container = _make_mock_container()
    mock_docker_client.containers.run.return_value = mock_container

    run(backend.create("session-1", {}))
    old_activity = backend._sandboxes["session-1"].last_activity

    time.sleep(0.01)

    backend.touch("session-1")
    new_activity = backend._sandboxes["session-1"].last_activity
    assert new_activity > old_activity


def test_touch_nonexistent_session_is_safe(backend):
    backend.touch("ghost-session")  # must not raise


# ------------------------------------------------------------------
# stop()
# ------------------------------------------------------------------


def test_stop_removes_container_and_record(backend, mock_docker_client):
    mock_container = _make_mock_container()
    mock_docker_client.containers.run.return_value = mock_container

    run(backend.create("session-1", {}))
    run(backend.stop("session-1"))

    mock_container.stop.assert_called_once()
    mock_container.remove.assert_called_once_with(force=True)
    assert "session-1" not in backend._sandboxes
    assert "session-1" not in backend._docker_state


def test_stop_nonexistent_session_is_safe(backend):
    run(backend.stop("ghost-session"))  # must not raise


def test_stop_tolerates_docker_errors(backend, mock_docker_client):
    """If Docker stop/remove raises, stop() logs warnings but does not raise."""
    mock_container = _make_mock_container()
    mock_container.stop.side_effect = Exception("stop failed")
    mock_container.remove.side_effect = Exception("remove failed")
    mock_docker_client.containers.run.return_value = mock_container

    run(backend.create("session-1", {}))
    run(backend.stop("session-1"))  # must not raise

    assert "session-1" not in backend._sandboxes


# ------------------------------------------------------------------
# cleanup_expired()
# ------------------------------------------------------------------


def test_cleanup_expired_removes_old_containers(backend, mock_docker_client):
    mock_container = _make_mock_container()
    mock_docker_client.containers.run.return_value = mock_container

    run(backend.create("old-session", {}))
    backend._sandboxes["old-session"].created_at = (
        datetime.now(timezone.utc) - timedelta(seconds=700)
    )

    removed = run(backend.cleanup_expired())
    assert removed == 1
    assert "old-session" not in backend._sandboxes


def test_cleanup_expired_keeps_recent_containers(backend, mock_docker_client):
    mock_container = _make_mock_container()
    mock_docker_client.containers.run.return_value = mock_container

    run(backend.create("new-session", {}))

    removed = run(backend.cleanup_expired())
    assert removed == 0
    assert "new-session" in backend._sandboxes


def test_cleanup_expired_removes_idle_containers(backend, mock_docker_client):
    """Container idle longer than idle_timeout is removed."""
    mock_container = _make_mock_container()
    mock_docker_client.containers.run.return_value = mock_container

    run(backend.create("idle-session", {}))
    # Created recently, but last_activity is old
    backend._sandboxes["idle-session"].last_activity = (
        datetime.now(timezone.utc) - timedelta(seconds=400)
    )

    removed = run(backend.cleanup_expired())
    assert removed == 1
    assert "idle-session" not in backend._sandboxes


def test_cleanup_expired_keeps_active_containers(backend, mock_docker_client):
    """Container within idle timeout is kept even if created long ago."""
    mock_container = _make_mock_container()
    mock_docker_client.containers.run.return_value = mock_container

    run(backend.create("active-session", {}))
    # Created long ago, but recently active
    backend._sandboxes["active-session"].created_at = (
        datetime.now(timezone.utc) - timedelta(seconds=500)
    )
    backend._sandboxes["active-session"].last_activity = datetime.now(timezone.utc)

    removed = run(backend.cleanup_expired())
    assert removed == 0
    assert "active-session" in backend._sandboxes


def test_cleanup_expired_removes_past_max_lifetime_even_if_active(
    backend, mock_docker_client
):
    """Container past max_lifetime is removed even if recently active."""
    mock_container = _make_mock_container()
    mock_docker_client.containers.run.return_value = mock_container

    run(backend.create("old-active-session", {}))
    # Past max lifetime but recently active
    backend._sandboxes["old-active-session"].created_at = (
        datetime.now(timezone.utc) - timedelta(seconds=700)
    )
    backend._sandboxes["old-active-session"].last_activity = datetime.now(timezone.utc)

    removed = run(backend.cleanup_expired())
    assert removed == 1
    assert "old-active-session" not in backend._sandboxes


# ------------------------------------------------------------------
# shutdown_all()
# ------------------------------------------------------------------


def test_shutdown_all_stops_all_containers(backend, mock_docker_client):
    mock_container_1 = _make_mock_container(container_id="abc1", ip_address="172.18.0.2")
    mock_container_2 = _make_mock_container(container_id="abc2", ip_address="172.18.0.3")

    mock_docker_client.containers.run.side_effect = [mock_container_1, mock_container_2]
    # No orphaned containers returned by label query
    mock_docker_client.containers.list.return_value = []

    run(backend.create("s1", {}))
    run(backend.create("s2", {}))
    run(backend.shutdown_all())

    mock_container_1.stop.assert_called_once()
    mock_container_2.stop.assert_called_once()
    assert len(backend._sandboxes) == 0
    assert len(backend._docker_state) == 0


def test_shutdown_all_cleans_up_orphaned_containers(backend, mock_docker_client):
    """Containers not in the in-memory registry are cleaned up via Docker labels."""
    orphan = MagicMock()
    orphan.id = "orphan123"

    # No tracked containers, but Docker finds an orphan by label
    mock_docker_client.containers.list.return_value = [orphan]

    run(backend.shutdown_all())

    orphan.stop.assert_called_once_with(timeout=5)
    orphan.remove.assert_called_once_with(force=True)


def test_shutdown_all_skips_tracked_containers_in_label_scan(
    backend, mock_docker_client
):
    """Containers already stopped via the registry are not stopped twice."""
    tracked = _make_mock_container(container_id="tracked1")
    mock_docker_client.containers.run.return_value = tracked

    run(backend.create("s1", {}))
    # The label scan returns the same container that was already in the registry
    mock_docker_client.containers.list.return_value = [tracked]

    run(backend.shutdown_all())

    # stop() called once by the registry path, not again by the label scan
    tracked.stop.assert_called_once()


# ------------------------------------------------------------------
# cleanup_orphaned()
# ------------------------------------------------------------------


def test_cleanup_orphaned_finds_and_removes_by_label(backend, mock_docker_client):
    orphan = MagicMock()
    orphan.id = "orphan456"
    mock_docker_client.containers.list.return_value = [orphan]

    count = run(backend.cleanup_orphaned())

    assert count == 1
    orphan.stop.assert_called_once_with(timeout=5)
    orphan.remove.assert_called_once_with(force=True)
    mock_docker_client.containers.list.assert_called_once_with(
        filters={"label": "app=duckdb-agent-sidecar"},
        all=True,
    )


def test_cleanup_orphaned_returns_zero_on_none(backend, mock_docker_client):
    mock_docker_client.containers.list.return_value = []

    count = run(backend.cleanup_orphaned())
    assert count == 0


def test_cleanup_by_label_handles_docker_error(backend, mock_docker_client):
    """If Docker listing fails, _cleanup_by_label returns 0 without raising."""
    mock_docker_client.containers.list.side_effect = Exception("Docker daemon error")

    result = backend._cleanup_by_label()
    assert result == 0


# ------------------------------------------------------------------
# gVisor DNS resolution
# ------------------------------------------------------------------


def test_resolve_network_hosts(backend, mock_docker_client):
    mock_network = MagicMock()
    mock_network.attrs = {
        "Containers": {
            "cid1": {"Name": "backend", "IPv4Address": "172.20.0.2/16"},
            "cid2": {"Name": "db", "IPv4Address": "172.20.0.3/16"},
        }
    }
    mock_docker_client.networks.get.return_value = mock_network

    hosts = backend._resolve_network_hosts()

    assert hosts == {"backend": "172.20.0.2", "db": "172.20.0.3"}


def test_resolve_network_hosts_handles_error(backend, mock_docker_client):
    mock_docker_client.networks.get.side_effect = Exception("network not found")

    hosts = backend._resolve_network_hosts()
    assert hosts == {}


def test_resolve_host_gateway_ip(backend, mock_docker_client):
    mock_network = MagicMock()
    mock_network.attrs = {
        "IPAM": {"Config": [{"Gateway": "172.20.0.1"}]}
    }
    mock_docker_client.networks.get.return_value = mock_network

    ip = backend._resolve_host_gateway_ip()
    assert ip == "172.20.0.1"


def test_resolve_host_gateway_ip_returns_none_on_error(backend, mock_docker_client):
    mock_docker_client.networks.get.side_effect = Exception("network not found")

    ip = backend._resolve_host_gateway_ip()
    assert ip is None


def test_resolve_host_gateway_ip_returns_none_when_no_gateway(
    backend, mock_docker_client
):
    mock_network = MagicMock()
    mock_network.attrs = {"IPAM": {"Config": [{}]}}
    mock_docker_client.networks.get.return_value = mock_network

    ip = backend._resolve_host_gateway_ip()
    assert ip is None


# ------------------------------------------------------------------
# SandboxInfo field mapping
# ------------------------------------------------------------------


def test_sandbox_info_has_correct_fields(backend, mock_docker_client):
    mock_container = _make_mock_container()
    mock_docker_client.containers.run.return_value = mock_container

    info = run(backend.create("session-1", {}))

    assert isinstance(info, SandboxInfo)
    assert info.sandbox_id == "abc123"
    assert info.session_id == "session-1"
    assert info.created_at is not None
    assert info.last_activity is not None
    assert info.last_activity == info.created_at


def test_sandbox_info_url_is_string(backend, mock_docker_client):
    mock_container = _make_mock_container()
    mock_docker_client.containers.run.return_value = mock_container

    info = run(backend.create("session-1", {}))

    assert isinstance(info.url, str)
    assert info.url.startswith("http://")
