import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch, PropertyMock

import pytest

from app.container_manager import ContainerManager, ContainerInfo, ContainerConfig


@pytest.fixture
def config():
    return ContainerConfig(
        image="duckdb-agent-sidecar:latest",
        runtime="runsc",
        memory_limit="256m",
        cpu_limit=0.5,
        max_lifetime_seconds=600,
        network="agent-sandbox",
    )


@pytest.fixture
def mock_docker_client():
    client = MagicMock()
    client.containers = MagicMock()
    client.networks = MagicMock()
    return client


@pytest.fixture
def manager(config, mock_docker_client):
    with patch("app.container_manager.docker") as mock_docker:
        mock_docker.from_env.return_value = mock_docker_client
        mgr = ContainerManager(config)
        mgr._client = mock_docker_client
        return mgr


def test_container_config_has_defaults():
    cfg = ContainerConfig()
    assert cfg.image == "duckdb-agent-sidecar:latest"
    assert cfg.runtime == "runsc"
    assert cfg.memory_limit == "256m"
    assert cfg.cpu_limit == 0.5
    assert cfg.max_lifetime_seconds == 600
    assert cfg.network == "agent-sandbox"


def test_create_stores_container_info(manager, mock_docker_client):
    mock_container = MagicMock()
    mock_container.id = "abc123"
    mock_container.attrs = {"NetworkSettings": {"Networks": {"agent-sandbox": {"IPAddress": "172.18.0.2"}}}}
    mock_docker_client.containers.run.return_value = mock_container

    info = manager.create("session-1", {"ANTHROPIC_API_KEY": "token123"})

    assert "session-1" in manager._containers
    assert info.container_id == "abc123"
    assert info.session_id == "session-1"


def test_create_passes_security_flags(manager, mock_docker_client):
    mock_container = MagicMock()
    mock_container.id = "abc123"
    mock_container.attrs = {"NetworkSettings": {"Networks": {"agent-sandbox": {"IPAddress": "172.18.0.2"}}}}
    mock_docker_client.containers.run.return_value = mock_container

    manager.create("session-1", {"ANTHROPIC_API_KEY": "token123"})

    call_kwargs = mock_docker_client.containers.run.call_args[1]
    assert call_kwargs["runtime"] == "runsc"
    assert call_kwargs["read_only"] is True
    assert call_kwargs["cap_drop"] == ["ALL"]
    assert call_kwargs["security_opt"] == ["no-new-privileges"]
    assert call_kwargs["detach"] is True


def test_stop_removes_container_and_record(manager, mock_docker_client):
    mock_container = MagicMock()
    mock_container.id = "abc123"
    mock_container.attrs = {"NetworkSettings": {"Networks": {"agent-sandbox": {"IPAddress": "172.18.0.2"}}}}
    mock_docker_client.containers.run.return_value = mock_container

    manager.create("session-1", {})
    manager.stop("session-1")

    mock_container.stop.assert_called_once()
    mock_container.remove.assert_called_once_with(force=True)
    assert "session-1" not in manager._containers


def test_stop_nonexistent_session_is_safe(manager):
    manager.stop("ghost-session")  # must not raise


def test_cleanup_expired_removes_old_containers(manager, mock_docker_client):
    mock_container = MagicMock()
    mock_container.id = "abc123"
    mock_container.attrs = {"NetworkSettings": {"Networks": {"agent-sandbox": {"IPAddress": "172.18.0.2"}}}}
    mock_docker_client.containers.run.return_value = mock_container

    manager.create("old-session", {})
    manager._containers["old-session"].created_at = (
        datetime.now(timezone.utc) - timedelta(seconds=700)
    )

    removed = manager.cleanup_expired()
    assert removed == 1
    assert "old-session" not in manager._containers


def test_cleanup_expired_keeps_recent_containers(manager, mock_docker_client):
    mock_container = MagicMock()
    mock_container.id = "abc123"
    mock_container.attrs = {"NetworkSettings": {"Networks": {"agent-sandbox": {"IPAddress": "172.18.0.2"}}}}
    mock_docker_client.containers.run.return_value = mock_container

    manager.create("new-session", {})

    removed = manager.cleanup_expired()
    assert removed == 0
    assert "new-session" in manager._containers


def test_shutdown_all_stops_all_containers(manager, mock_docker_client):
    mock_container_1 = MagicMock()
    mock_container_1.id = "abc1"
    mock_container_1.attrs = {"NetworkSettings": {"Networks": {"agent-sandbox": {"IPAddress": "172.18.0.2"}}}}

    mock_container_2 = MagicMock()
    mock_container_2.id = "abc2"
    mock_container_2.attrs = {"NetworkSettings": {"Networks": {"agent-sandbox": {"IPAddress": "172.18.0.3"}}}}

    mock_docker_client.containers.run.side_effect = [mock_container_1, mock_container_2]
    # No orphaned containers returned by label query
    mock_docker_client.containers.list.return_value = []

    manager.create("s1", {})
    manager.create("s2", {})
    manager.shutdown_all()

    mock_container_1.stop.assert_called_once()
    mock_container_2.stop.assert_called_once()
    assert len(manager._containers) == 0


def test_shutdown_all_cleans_up_orphaned_containers(manager, mock_docker_client):
    """Containers not in the in-memory registry are still cleaned up via Docker labels."""
    orphan = MagicMock()
    orphan.id = "orphan123"

    # No tracked containers, but Docker finds an orphan by label
    mock_docker_client.containers.list.return_value = [orphan]

    manager.shutdown_all()

    orphan.stop.assert_called_once_with(timeout=5)
    orphan.remove.assert_called_once_with(force=True)


def test_shutdown_all_skips_tracked_containers_in_label_scan(manager, mock_docker_client):
    """Containers already stopped via the registry are not stopped twice."""
    tracked = MagicMock()
    tracked.id = "tracked1"
    tracked.attrs = {"NetworkSettings": {"Networks": {"agent-sandbox": {"IPAddress": "172.18.0.2"}}}}
    mock_docker_client.containers.run.return_value = tracked

    manager.create("s1", {})
    # The label scan returns the same container that was already in the registry
    mock_docker_client.containers.list.return_value = [tracked]

    manager.shutdown_all()

    # stop() called once by the registry path, not again by the label scan
    tracked.stop.assert_called_once()


def test_cleanup_by_label_handles_docker_error(manager, mock_docker_client):
    """If Docker listing fails, _cleanup_by_label returns 0 without raising."""
    mock_docker_client.containers.list.side_effect = Exception("Docker daemon error")

    result = manager._cleanup_by_label()

    assert result == 0


def test_get_url_returns_correct_format(manager, mock_docker_client):
    mock_container = MagicMock()
    mock_container.id = "abc123"
    mock_container.attrs = {"NetworkSettings": {"Networks": {"agent-sandbox": {"IPAddress": "172.18.0.2"}}}}
    mock_docker_client.containers.run.return_value = mock_container

    info = manager.create("session-1", {})
    assert info.url == "http://172.18.0.2:3000"
