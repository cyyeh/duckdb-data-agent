from app.sandbox.base import SandboxBackend, SandboxInfo

__all__ = ["SandboxBackend", "SandboxInfo", "get_sandbox_backend"]

_singleton: SandboxBackend | None = None


def get_sandbox_backend(runtime: str | None = None) -> SandboxBackend:
    """Return the singleton sandbox backend, creating it on first call."""
    global _singleton
    if _singleton is not None:
        return _singleton

    from app.config import SANDBOX_RUNTIME
    rt = runtime or SANDBOX_RUNTIME

    if rt == "docker":
        from app.sandbox.docker_backend import DockerBackend, DockerConfig
        from app.config import (
            CONTAINER_IMAGE, CONTAINER_RUNTIME, CONTAINER_MEMORY_LIMIT,
            CONTAINER_CPU_LIMIT, CONTAINER_MAX_LIFETIME_SECONDS,
            CONTAINER_IDLE_TIMEOUT_SECONDS, CONTAINER_NETWORK,
        )
        _singleton = DockerBackend(DockerConfig(
            image=CONTAINER_IMAGE,
            runtime=CONTAINER_RUNTIME,
            memory_limit=CONTAINER_MEMORY_LIMIT,
            cpu_limit=CONTAINER_CPU_LIMIT,
            max_lifetime_seconds=CONTAINER_MAX_LIFETIME_SECONDS,
            idle_timeout_seconds=CONTAINER_IDLE_TIMEOUT_SECONDS,
            network=CONTAINER_NETWORK,
        ))
    elif rt == "k8s":
        from app.sandbox.k8s_backend import K8sBackend, K8sConfig
        from app.config import (
            K8S_TEMPLATE_NAME, K8S_NAMESPACE, K8S_GATEWAY_NAME,
            K8S_API_URL,
            CONTAINER_MAX_LIFETIME_SECONDS, CONTAINER_IDLE_TIMEOUT_SECONDS,
        )
        _singleton = K8sBackend(K8sConfig(
            template_name=K8S_TEMPLATE_NAME,
            namespace=K8S_NAMESPACE,
            gateway_name=K8S_GATEWAY_NAME,
            api_url=K8S_API_URL,
            max_lifetime_seconds=CONTAINER_MAX_LIFETIME_SECONDS,
            idle_timeout_seconds=CONTAINER_IDLE_TIMEOUT_SECONDS,
        ))
    else:
        raise ValueError(f"Unknown SANDBOX_RUNTIME: {rt!r}. Use 'docker' or 'k8s'.")

    return _singleton
