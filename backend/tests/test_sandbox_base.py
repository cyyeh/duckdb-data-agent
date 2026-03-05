from datetime import datetime, timezone

import pytest

from app.sandbox.base import SandboxBackend, SandboxInfo


def test_sandbox_info_url_stored():
    info = SandboxInfo(
        sandbox_id="abc123",
        session_id="session-1",
        url="http://172.18.0.2:3000",
    )
    assert info.url == "http://172.18.0.2:3000"
    assert info.sandbox_id == "abc123"
    assert info.session_id == "session-1"


def test_sandbox_info_last_activity_defaults_to_created_at():
    info = SandboxInfo(
        sandbox_id="abc123",
        session_id="session-1",
        url="http://172.18.0.2:3000",
    )
    assert info.last_activity == info.created_at


def test_sandbox_backend_cannot_be_instantiated():
    with pytest.raises(TypeError):
        SandboxBackend()
