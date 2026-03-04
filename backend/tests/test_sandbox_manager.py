"""Tests for SandboxManager — OpenSandbox-based container lifecycle."""
import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.sandbox_manager import SandboxManager, SandboxConfig, SandboxInfo


@pytest.fixture
def config():
    return SandboxConfig(
        image="duckdb-agent-sidecar:latest",
        memory_limit="256m",
        cpu_limit=0.5,
        max_lifetime_seconds=3600,
        idle_timeout_seconds=300,
        opensandbox_domain="localhost:8080",
    )


@pytest.fixture
def manager(config):
    return SandboxManager(config)


class TestSandboxConfig:
    def test_defaults(self):
        cfg = SandboxConfig()
        assert cfg.image == "duckdb-agent-sidecar:latest"
        assert cfg.memory_limit == "512m"
        assert cfg.cpu_limit == 0.5
        assert cfg.opensandbox_domain == "localhost:8080"

    def test_resource_dict(self):
        cfg = SandboxConfig(memory_limit="1Gi", cpu_limit=2.0)
        res = cfg.resource_dict()
        assert res == {"cpu": "2", "memory": "1Gi"}

    def test_resource_dict_fractional_cpu(self):
        cfg = SandboxConfig(cpu_limit=0.5)
        res = cfg.resource_dict()
        assert res == {"cpu": "0.5", "memory": "512m"}


class TestSandboxManagerCreate:
    @pytest.mark.asyncio
    async def test_create_returns_sandbox_info(self, manager):
        mock_sandbox = AsyncMock()
        mock_sandbox.id = "sandbox-123"

        mock_endpoint = MagicMock()
        mock_endpoint.endpoint = "192.168.1.100:3000"
        mock_endpoint.headers = {}
        mock_sandbox.get_endpoint = AsyncMock(return_value=mock_endpoint)

        with patch("app.sandbox_manager.Sandbox") as MockSandbox:
            MockSandbox.create = AsyncMock(return_value=mock_sandbox)

            info = await manager.create("session-1", {"KEY": "value"})

            assert info.sandbox_id == "sandbox-123"
            assert info.session_id == "session-1"
            assert info.url == "http://192.168.1.100:3000"
            MockSandbox.create.assert_called_once()

    @pytest.mark.asyncio
    async def test_create_reuses_existing(self, manager):
        mock_sandbox = AsyncMock()
        mock_sandbox.id = "sandbox-123"
        mock_endpoint = MagicMock()
        mock_endpoint.endpoint = "192.168.1.100:3000"
        mock_endpoint.headers = {}
        mock_sandbox.get_endpoint = AsyncMock(return_value=mock_endpoint)

        with patch("app.sandbox_manager.Sandbox") as MockSandbox:
            MockSandbox.create = AsyncMock(return_value=mock_sandbox)
            info1 = await manager.create("session-1", {"KEY": "value"})
            info2 = await manager.create("session-1", {"KEY": "value"})
            assert info1 is info2
            assert MockSandbox.create.call_count == 1


class TestSandboxManagerGet:
    @pytest.mark.asyncio
    async def test_get_returns_none_when_missing(self, manager):
        assert manager.get("nonexistent") is None

    @pytest.mark.asyncio
    async def test_get_returns_info_after_create(self, manager):
        mock_sandbox = AsyncMock()
        mock_sandbox.id = "sandbox-123"
        mock_endpoint = MagicMock()
        mock_endpoint.endpoint = "192.168.1.100:3000"
        mock_endpoint.headers = {}
        mock_sandbox.get_endpoint = AsyncMock(return_value=mock_endpoint)

        with patch("app.sandbox_manager.Sandbox") as MockSandbox:
            MockSandbox.create = AsyncMock(return_value=mock_sandbox)
            await manager.create("session-1", {})
            info = manager.get("session-1")
            assert info is not None
            assert info.session_id == "session-1"


class TestSandboxManagerTouch:
    @pytest.mark.asyncio
    async def test_touch_updates_last_activity(self, manager):
        mock_sandbox = AsyncMock()
        mock_sandbox.id = "sandbox-123"
        mock_endpoint = MagicMock()
        mock_endpoint.endpoint = "192.168.1.100:3000"
        mock_endpoint.headers = {}
        mock_sandbox.get_endpoint = AsyncMock(return_value=mock_endpoint)

        with patch("app.sandbox_manager.Sandbox") as MockSandbox:
            MockSandbox.create = AsyncMock(return_value=mock_sandbox)
            await manager.create("session-1", {})
            before = manager.get("session-1").last_activity
            await asyncio.sleep(0.01)
            manager.touch("session-1")
            after = manager.get("session-1").last_activity
            assert after > before


class TestSandboxManagerStop:
    @pytest.mark.asyncio
    async def test_stop_kills_sandbox_and_removes(self, manager):
        mock_sandbox = AsyncMock()
        mock_sandbox.id = "sandbox-123"
        mock_sandbox.kill = AsyncMock()
        mock_endpoint = MagicMock()
        mock_endpoint.endpoint = "192.168.1.100:3000"
        mock_endpoint.headers = {}
        mock_sandbox.get_endpoint = AsyncMock(return_value=mock_endpoint)

        with patch("app.sandbox_manager.Sandbox") as MockSandbox:
            MockSandbox.create = AsyncMock(return_value=mock_sandbox)
            await manager.create("session-1", {})
            await manager.stop("session-1")
            mock_sandbox.kill.assert_called_once()
            assert manager.get("session-1") is None


class TestSandboxManagerCleanup:
    @pytest.mark.asyncio
    async def test_cleanup_expired_removes_idle(self, manager):
        mock_sandbox = AsyncMock()
        mock_sandbox.id = "sandbox-123"
        mock_sandbox.kill = AsyncMock()
        mock_endpoint = MagicMock()
        mock_endpoint.endpoint = "192.168.1.100:3000"
        mock_endpoint.headers = {}
        mock_sandbox.get_endpoint = AsyncMock(return_value=mock_endpoint)

        with patch("app.sandbox_manager.Sandbox") as MockSandbox:
            MockSandbox.create = AsyncMock(return_value=mock_sandbox)
            await manager.create("session-1", {})

            # Backdate last_activity so it's past idle timeout
            info = manager.get("session-1")
            info.last_activity = datetime.now(timezone.utc) - timedelta(seconds=400)

            removed = await manager.cleanup_expired()
            assert removed == 1
            assert manager.get("session-1") is None


class TestSandboxManagerShutdownAll:
    @pytest.mark.asyncio
    async def test_shutdown_all_kills_all(self, manager):
        mock_sandbox1 = AsyncMock()
        mock_sandbox1.id = "sandbox-1"
        mock_sandbox1.kill = AsyncMock()
        mock_sandbox2 = AsyncMock()
        mock_sandbox2.id = "sandbox-2"
        mock_sandbox2.kill = AsyncMock()

        mock_endpoint = MagicMock()
        mock_endpoint.endpoint = "192.168.1.100:3000"
        mock_endpoint.headers = {}

        sandbox_iter = iter([mock_sandbox1, mock_sandbox2])

        with patch("app.sandbox_manager.Sandbox") as MockSandbox:
            MockSandbox.create = AsyncMock(side_effect=lambda *a, **kw: next(sandbox_iter))
            for sb in [mock_sandbox1, mock_sandbox2]:
                sb.get_endpoint = AsyncMock(return_value=mock_endpoint)
            await manager.create("session-1", {})
            await manager.create("session-2", {})

            await manager.shutdown_all()

            mock_sandbox1.kill.assert_called_once()
            mock_sandbox2.kill.assert_called_once()


class TestSandboxManagerCleanupOrphaned:
    @pytest.mark.asyncio
    async def test_cleanup_orphaned_kills_untracked(self, manager):
        # Set up a tracked sandbox in the manager
        mock_sandbox = AsyncMock()
        mock_sandbox.id = "tracked-sandbox-1"
        mock_endpoint = MagicMock()
        mock_endpoint.endpoint = "192.168.1.100:3000"
        mock_endpoint.headers = {}
        mock_sandbox.get_endpoint = AsyncMock(return_value=mock_endpoint)

        with patch("app.sandbox_manager.Sandbox") as MockSandbox:
            MockSandbox.create = AsyncMock(return_value=mock_sandbox)
            await manager.create("session-1", {})

        # Build fake sandbox infos returned by OSManager.list_sandbox_infos
        tracked_info = MagicMock()
        tracked_info.id = "tracked-sandbox-1"
        orphan_info = MagicMock()
        orphan_info.id = "orphaned-sandbox-2"

        mock_mgr_instance = AsyncMock()
        mock_mgr_instance.list_sandbox_infos = AsyncMock(
            return_value=MagicMock(sandbox_infos=[tracked_info, orphan_info])
        )
        mock_mgr_instance.kill_sandbox = AsyncMock()
        # Support async context manager protocol
        mock_mgr_instance.__aenter__ = AsyncMock(return_value=mock_mgr_instance)
        mock_mgr_instance.__aexit__ = AsyncMock(return_value=False)

        with patch("app.sandbox_manager.OSManager") as MockOSManager, \
             patch("app.sandbox_manager.SandboxFilter"):
            MockOSManager.create = AsyncMock(return_value=mock_mgr_instance)

            count = await manager.cleanup_orphaned()

        assert count == 1
        mock_mgr_instance.kill_sandbox.assert_called_once_with("orphaned-sandbox-2")

    @pytest.mark.asyncio
    async def test_cleanup_orphaned_returns_zero_on_error(self, manager):
        with patch("app.sandbox_manager.OSManager") as MockOSManager:
            MockOSManager.create = AsyncMock(
                side_effect=RuntimeError("connection refused")
            )

            count = await manager.cleanup_orphaned()

        assert count == 0
