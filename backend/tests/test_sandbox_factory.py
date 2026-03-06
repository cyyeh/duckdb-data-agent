# backend/tests/test_sandbox_factory.py
from unittest.mock import patch

import pytest

import app.sandbox as sandbox_mod
from app.sandbox import get_sandbox_backend
from app.sandbox.docker_backend import DockerBackend
from app.sandbox.k8s_backend import K8sBackend


@pytest.fixture(autouse=True)
def _reset_singleton():
    """Reset the sandbox backend singleton between tests."""
    sandbox_mod._singleton = None
    yield
    sandbox_mod._singleton = None


def test_factory_returns_docker_backend_by_default():
    with patch("app.sandbox.docker_backend.docker"):
        backend = get_sandbox_backend(runtime="docker")
    assert isinstance(backend, DockerBackend)


def test_factory_returns_k8s_backend():
    backend = get_sandbox_backend(runtime="k8s")
    assert isinstance(backend, K8sBackend)


def test_factory_raises_on_unknown_runtime():
    with pytest.raises(ValueError, match="Unknown SANDBOX_RUNTIME"):
        get_sandbox_backend(runtime="invalid")
