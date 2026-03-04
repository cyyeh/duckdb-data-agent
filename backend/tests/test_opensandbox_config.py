import os
import importlib


def test_sandbox_runtime_defaults_to_docker(monkeypatch):
    """SANDBOX_RUNTIME should default to 'docker'."""
    monkeypatch.delenv("SANDBOX_RUNTIME", raising=False)
    import app.config
    importlib.reload(app.config)
    assert app.config.SANDBOX_RUNTIME == "docker"


def test_sandbox_runtime_reads_env(monkeypatch):
    """SANDBOX_RUNTIME should read from environment."""
    monkeypatch.setenv("SANDBOX_RUNTIME", "kubernetes")
    import app.config
    importlib.reload(app.config)
    assert app.config.SANDBOX_RUNTIME == "kubernetes"


def test_opensandbox_domain_default(monkeypatch):
    monkeypatch.delenv("OPENSANDBOX_DOMAIN", raising=False)
    import app.config
    importlib.reload(app.config)
    assert app.config.OPENSANDBOX_DOMAIN == "localhost:8080"


def test_k8s_namespace_default(monkeypatch):
    monkeypatch.delenv("K8S_NAMESPACE", raising=False)
    import app.config
    importlib.reload(app.config)
    assert app.config.K8S_NAMESPACE == "default"
