import asyncio
import time
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.sandbox.base import SandboxBackend, SandboxInfo
from app.sandbox.k8s_backend import K8sBackend, K8sConfig


def run(coro):
    """Run an async coroutine to completion (test helper)."""
    loop = asyncio.get_event_loop()
    return loop.run_until_complete(coro)


# ------------------------------------------------------------------
# K8sConfig tests
# ------------------------------------------------------------------


def test_k8s_config_has_defaults():
    cfg = K8sConfig()
    assert cfg.template_name == "duckdb-agent-sidecar"
    assert cfg.namespace == "default"
    assert cfg.gateway_name == ""
    assert cfg.server_port == 3000
    assert cfg.max_lifetime_seconds == 3600
    assert cfg.idle_timeout_seconds == 300


def test_k8s_config_custom_values():
    cfg = K8sConfig(
        template_name="custom-template",
        namespace="prod",
        gateway_name="my-gateway",
        server_port=8080,
        max_lifetime_seconds=7200,
        idle_timeout_seconds=600,
    )
    assert cfg.template_name == "custom-template"
    assert cfg.namespace == "prod"
    assert cfg.gateway_name == "my-gateway"
    assert cfg.server_port == 8080
    assert cfg.max_lifetime_seconds == 7200
    assert cfg.idle_timeout_seconds == 600


# ------------------------------------------------------------------
# Fixtures
# ------------------------------------------------------------------


@pytest.fixture
def config():
    return K8sConfig(
        max_lifetime_seconds=600,
        idle_timeout_seconds=300,
    )


def _make_mock_client():
    """Create a mock SandboxClient with sync context manager support."""
    client = MagicMock()
    client.__enter__ = MagicMock(return_value=client)
    client.__exit__ = MagicMock(return_value=None)
    client.host = "10.0.0.42"
    return client


@pytest.fixture
def mock_sandbox_client():
    return _make_mock_client()


@pytest.fixture
def backend(config):
    """Create a K8sBackend with SandboxClient patched to a non-None value."""
    with patch("app.sandbox.k8s_backend.SandboxClient", new=MagicMock):
        be = K8sBackend(config)
    return be


# ------------------------------------------------------------------
# K8sBackend implements SandboxBackend
# ------------------------------------------------------------------


def test_k8s_backend_is_sandbox_backend(backend):
    assert isinstance(backend, SandboxBackend)


# ------------------------------------------------------------------
# create()
# ------------------------------------------------------------------


@patch("app.sandbox.k8s_backend._resolve_endpoint", new_callable=AsyncMock)
@patch("app.sandbox.k8s_backend.SandboxClient")
def test_create_stores_sandbox_info(
    mock_client_cls, mock_resolve, config
):
    client = _make_mock_client()
    mock_client_cls.return_value = client
    mock_resolve.return_value = "http://10.0.0.42:3000"

    be = K8sBackend(config)
    info = run(be.create("session-1", {"ANTHROPIC_API_KEY": "key123"}))

    assert "session-1" in be._sandboxes
    assert isinstance(info, SandboxInfo)
    assert info.session_id == "session-1"
    assert info.url == "http://10.0.0.42:3000"
    client.__enter__.assert_called_once()


@patch("app.sandbox.k8s_backend._resolve_endpoint", new_callable=AsyncMock)
@patch("app.sandbox.k8s_backend.SandboxClient")
def test_create_returns_existing_for_same_session(
    mock_client_cls, mock_resolve, config
):
    client = _make_mock_client()
    mock_client_cls.return_value = client
    mock_resolve.return_value = "http://10.0.0.42:3000"

    be = K8sBackend(config)
    info1 = run(be.create("session-1", {}))
    info2 = run(be.create("session-1", {}))

    assert info1 is info2
    # SandboxClient constructor called only once
    mock_client_cls.assert_called_once()


@patch("app.sandbox.k8s_backend._resolve_endpoint", new_callable=AsyncMock)
@patch("app.sandbox.k8s_backend.SandboxClient")
def test_create_passes_template_and_namespace(
    mock_client_cls, mock_resolve, config
):
    client = _make_mock_client()
    mock_client_cls.return_value = client
    mock_resolve.return_value = "http://10.0.0.42:3000"

    be = K8sBackend(config)
    run(be.create("session-1", {}))

    call_kwargs = mock_client_cls.call_args[1]
    assert call_kwargs["template_name"] == "duckdb-agent-sidecar"
    assert call_kwargs["namespace"] == "default"
    assert call_kwargs["server_port"] == 3000
    # gateway_name should not be passed when empty
    assert "gateway_name" not in call_kwargs


@patch("app.sandbox.k8s_backend._resolve_endpoint", new_callable=AsyncMock)
@patch("app.sandbox.k8s_backend.SandboxClient")
def test_create_passes_gateway_name_when_set(
    mock_client_cls, mock_resolve
):
    cfg = K8sConfig(gateway_name="my-gateway")
    client = _make_mock_client()
    mock_client_cls.return_value = client
    mock_resolve.return_value = "http://10.0.0.42:3000"

    be = K8sBackend(cfg)
    run(be.create("session-1", {}))

    call_kwargs = mock_client_cls.call_args[1]
    assert call_kwargs["gateway_name"] == "my-gateway"


@patch("app.sandbox.k8s_backend._resolve_endpoint", new_callable=AsyncMock)
@patch("app.sandbox.k8s_backend.SandboxClient")
def test_create_stores_client_for_cleanup(
    mock_client_cls, mock_resolve, config
):
    client = _make_mock_client()
    mock_client_cls.return_value = client
    mock_resolve.return_value = "http://10.0.0.42:3000"

    be = K8sBackend(config)
    run(be.create("session-1", {}))

    assert "session-1" in be._clients
    assert be._clients["session-1"] is client


@patch("app.sandbox.k8s_backend.SandboxClient", None)
def test_create_raises_when_sdk_not_installed(config):
    be = K8sBackend(config)
    with pytest.raises(RuntimeError, match="k8s-agent-sandbox is not installed"):
        run(be.create("session-1", {}))


# ------------------------------------------------------------------
# get()
# ------------------------------------------------------------------


@patch("app.sandbox.k8s_backend._resolve_endpoint", new_callable=AsyncMock)
@patch("app.sandbox.k8s_backend.SandboxClient")
def test_get_returns_sandbox_info(mock_client_cls, mock_resolve, config):
    client = _make_mock_client()
    mock_client_cls.return_value = client
    mock_resolve.return_value = "http://10.0.0.42:3000"

    be = K8sBackend(config)
    run(be.create("session-1", {}))
    info = be.get("session-1")

    assert info is not None
    assert info.session_id == "session-1"


def test_get_returns_none_for_unknown_session(backend):
    assert backend.get("unknown") is None


# ------------------------------------------------------------------
# touch()
# ------------------------------------------------------------------


@patch("app.sandbox.k8s_backend._resolve_endpoint", new_callable=AsyncMock)
@patch("app.sandbox.k8s_backend.SandboxClient")
def test_touch_updates_last_activity(mock_client_cls, mock_resolve, config):
    client = _make_mock_client()
    mock_client_cls.return_value = client
    mock_resolve.return_value = "http://10.0.0.42:3000"

    be = K8sBackend(config)
    run(be.create("session-1", {}))
    old_activity = be._sandboxes["session-1"].last_activity

    time.sleep(0.01)

    be.touch("session-1")
    new_activity = be._sandboxes["session-1"].last_activity
    assert new_activity > old_activity


def test_touch_nonexistent_session_is_safe(backend):
    backend.touch("ghost-session")  # must not raise


# ------------------------------------------------------------------
# stop()
# ------------------------------------------------------------------


@patch("app.sandbox.k8s_backend._resolve_endpoint", new_callable=AsyncMock)
@patch("app.sandbox.k8s_backend.SandboxClient")
def test_stop_destroys_sandbox_and_removes_record(
    mock_client_cls, mock_resolve, config
):
    client = _make_mock_client()
    mock_client_cls.return_value = client
    mock_resolve.return_value = "http://10.0.0.42:3000"

    be = K8sBackend(config)
    run(be.create("session-1", {}))
    run(be.stop("session-1"))

    client.__exit__.assert_called_once_with(None, None, None)
    assert "session-1" not in be._sandboxes
    assert "session-1" not in be._clients


def test_stop_nonexistent_session_is_safe(backend):
    run(backend.stop("ghost-session"))  # must not raise


@patch("app.sandbox.k8s_backend._resolve_endpoint", new_callable=AsyncMock)
@patch("app.sandbox.k8s_backend.SandboxClient")
def test_stop_tolerates_aexit_errors(mock_client_cls, mock_resolve, config):
    """If __exit__ raises, stop() logs a warning but does not raise."""
    client = _make_mock_client()
    client.__exit__ = MagicMock(side_effect=Exception("destroy failed"))
    mock_client_cls.return_value = client
    mock_resolve.return_value = "http://10.0.0.42:3000"

    be = K8sBackend(config)
    run(be.create("session-1", {}))
    run(be.stop("session-1"))  # must not raise

    assert "session-1" not in be._sandboxes


# ------------------------------------------------------------------
# cleanup_expired()
# ------------------------------------------------------------------


@patch("app.sandbox.k8s_backend._resolve_endpoint", new_callable=AsyncMock)
@patch("app.sandbox.k8s_backend.SandboxClient")
def test_cleanup_expired_removes_old_sandboxes(
    mock_client_cls, mock_resolve, config
):
    client = _make_mock_client()
    mock_client_cls.return_value = client
    mock_resolve.return_value = "http://10.0.0.42:3000"

    be = K8sBackend(config)
    run(be.create("old-session", {}))
    # Push created_at back past max_lifetime
    be._sandboxes["old-session"].created_at = (
        datetime.now(timezone.utc) - timedelta(seconds=700)
    )

    removed = run(be.cleanup_expired())
    assert removed == 1
    assert "old-session" not in be._sandboxes


@patch("app.sandbox.k8s_backend._resolve_endpoint", new_callable=AsyncMock)
@patch("app.sandbox.k8s_backend.SandboxClient")
def test_cleanup_expired_keeps_recent_sandboxes(
    mock_client_cls, mock_resolve, config
):
    client = _make_mock_client()
    mock_client_cls.return_value = client
    mock_resolve.return_value = "http://10.0.0.42:3000"

    be = K8sBackend(config)
    run(be.create("new-session", {}))

    removed = run(be.cleanup_expired())
    assert removed == 0
    assert "new-session" in be._sandboxes


@patch("app.sandbox.k8s_backend._resolve_endpoint", new_callable=AsyncMock)
@patch("app.sandbox.k8s_backend.SandboxClient")
def test_cleanup_expired_removes_idle_sandboxes(
    mock_client_cls, mock_resolve, config
):
    """Sandbox idle longer than idle_timeout is removed."""
    client = _make_mock_client()
    mock_client_cls.return_value = client
    mock_resolve.return_value = "http://10.0.0.42:3000"

    be = K8sBackend(config)
    run(be.create("idle-session", {}))
    be._sandboxes["idle-session"].last_activity = (
        datetime.now(timezone.utc) - timedelta(seconds=400)
    )

    removed = run(be.cleanup_expired())
    assert removed == 1
    assert "idle-session" not in be._sandboxes


@patch("app.sandbox.k8s_backend._resolve_endpoint", new_callable=AsyncMock)
@patch("app.sandbox.k8s_backend.SandboxClient")
def test_cleanup_expired_removes_past_max_lifetime_even_if_active(
    mock_client_cls, mock_resolve, config
):
    """Sandbox past max_lifetime is removed even if recently active."""
    client = _make_mock_client()
    mock_client_cls.return_value = client
    mock_resolve.return_value = "http://10.0.0.42:3000"

    be = K8sBackend(config)
    run(be.create("old-active-session", {}))
    be._sandboxes["old-active-session"].created_at = (
        datetime.now(timezone.utc) - timedelta(seconds=700)
    )
    be._sandboxes["old-active-session"].last_activity = datetime.now(timezone.utc)

    removed = run(be.cleanup_expired())
    assert removed == 1
    assert "old-active-session" not in be._sandboxes


# ------------------------------------------------------------------
# shutdown_all()
# ------------------------------------------------------------------


@patch("app.sandbox.k8s_backend._resolve_endpoint", new_callable=AsyncMock)
@patch("app.sandbox.k8s_backend.SandboxClient")
def test_shutdown_all_stops_all_sandboxes(
    mock_client_cls, mock_resolve, config
):
    client1 = _make_mock_client()
    client2 = _make_mock_client()
    mock_client_cls.side_effect = [client1, client2]
    mock_resolve.return_value = "http://10.0.0.42:3000"

    be = K8sBackend(config)
    run(be.create("s1", {}))
    run(be.create("s2", {}))
    run(be.shutdown_all())

    client1.__exit__.assert_called_once()
    client2.__exit__.assert_called_once()
    assert len(be._sandboxes) == 0
    assert len(be._clients) == 0


# ------------------------------------------------------------------
# cleanup_orphaned()
# ------------------------------------------------------------------


@patch("app.sandbox.k8s_backend._init_k8s_api")
def test_cleanup_orphaned_deletes_untracked_claims(mock_init_api):
    """cleanup_orphaned should delete claims not tracked in _sandboxes."""
    mock_api = MagicMock()
    mock_api.list_namespaced_custom_object.return_value = {
        "items": [
            {"metadata": {"name": "sandbox-claim-aaa"}},
            {"metadata": {"name": "sandbox-claim-bbb"}},
        ]
    }
    mock_api.delete_namespaced_custom_object.return_value = None
    mock_init_api.return_value = mock_api

    be = K8sBackend(K8sConfig())
    count = run(be.cleanup_orphaned())

    assert count == 2
    assert mock_api.delete_namespaced_custom_object.call_count == 2


@patch("app.sandbox.k8s_backend._init_k8s_api")
def test_cleanup_orphaned_skips_tracked_claims(mock_init_api):
    """cleanup_orphaned should not delete claims tracked by active sessions."""
    mock_api = MagicMock()
    mock_api.list_namespaced_custom_object.return_value = {
        "items": [
            {"metadata": {"name": "sandbox-claim-tracked"}},
            {"metadata": {"name": "sandbox-claim-orphan"}},
        ]
    }
    mock_api.delete_namespaced_custom_object.return_value = None
    mock_init_api.return_value = mock_api

    be = K8sBackend(K8sConfig())
    # Simulate a tracked client
    tracked_client = MagicMock()
    tracked_client.claim_name = "sandbox-claim-tracked"
    be._clients["session-1"] = tracked_client

    count = run(be.cleanup_orphaned())

    assert count == 1
    mock_api.delete_namespaced_custom_object.assert_called_once()
    call_args = mock_api.delete_namespaced_custom_object.call_args
    assert call_args.kwargs["name"] == "sandbox-claim-orphan"


def test_cleanup_orphaned_returns_zero_when_no_api(backend):
    """cleanup_orphaned should return 0 when K8s API is unavailable."""
    backend._k8s_api = None
    count = run(backend.cleanup_orphaned())
    assert count == 0


# ------------------------------------------------------------------
# SandboxInfo field mapping
# ------------------------------------------------------------------


@patch("app.sandbox.k8s_backend._resolve_endpoint", new_callable=AsyncMock)
@patch("app.sandbox.k8s_backend.SandboxClient")
def test_sandbox_info_has_correct_fields(mock_client_cls, mock_resolve, config):
    client = _make_mock_client()
    mock_client_cls.return_value = client
    mock_resolve.return_value = "http://10.0.0.42:3000"

    be = K8sBackend(config)
    info = run(be.create("session-1", {}))

    assert isinstance(info, SandboxInfo)
    assert info.session_id == "session-1"
    assert info.url == "http://10.0.0.42:3000"
    assert info.created_at is not None
    assert info.last_activity is not None
    assert info.last_activity == info.created_at
