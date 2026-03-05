# K8s Agent-Sandbox Integration Design

**Date**: 2026-03-05
**Status**: Approved
**Replaces**: 2026-03-04-opensandbox-integration-design.md

## Goal

Remove the OpenSandbox dependency, restore the original Docker workflow (container_manager.py), and add direct Kubernetes support via the `kubernetes-sigs/agent-sandbox` project.

## Approach: Strategy Pattern

Two backend implementations behind a common `SandboxBackend` ABC, selected at startup by `SANDBOX_RUNTIME` env var.

```
                    ┌─────────────────────┐
                    │  SANDBOX_RUNTIME    │
                    │  "docker" | "k8s"   │
                    └────────┬────────────┘
                             │
               ┌─────────────┴─────────────┐
               │    SandboxBackend (ABC)    │
               │  create / get / touch      │
               │  stop / cleanup_expired    │
               │  shutdown_all / startup    │
               └─────────────┬─────────────┘
               ┌─────────────┴─────────────┐
     ┌─────────┴──────────┐  ┌─────────────┴──────────┐
     │  DockerBackend     │  │  K8sBackend            │
     │  (docker SDK)      │  │  (k8s-agent-sandbox)   │
     └────────────────────┘  └────────────────────────┘
```

## File Structure

```
backend/app/
├── sandbox/
│   ├── __init__.py          # factory: get_sandbox_backend()
│   ├── base.py              # SandboxBackend ABC + SandboxInfo dataclass
│   ├── docker_backend.py    # DockerBackend (current container_manager.py logic)
│   └── k8s_backend.py       # K8sBackend (k8s-agent-sandbox SDK)
├── config.py                # add SANDBOX_RUNTIME, K8S_* vars
├── main.py                  # import from sandbox/ instead of container_manager
├── agent.py                 # import from sandbox/ instead of container_manager
├── container_manager.py     # DELETE (moved into sandbox/docker_backend.py)
```

## ABC Definition (base.py)

```python
@dataclass
class SandboxInfo:
    sandbox_id: str
    session_id: str
    url: str                    # "http://host:port" — ready to use
    created_at: datetime
    last_activity: datetime

class SandboxBackend(ABC):
    async def create(self, session_id: str, env: dict[str, str]) -> SandboxInfo
    def get(self, session_id: str) -> SandboxInfo | None
    def touch(self, session_id: str) -> None
    async def stop(self, session_id: str) -> None
    async def cleanup_expired(self) -> int
    async def shutdown_all(self) -> None
    async def cleanup_orphaned(self) -> int
```

## DockerBackend

Current `container_manager.py` logic, minimally refactored:

- `ContainerConfig` dataclass preserved (image, runtime, memory_limit, cpu_limit, network)
- All Docker SDK logic preserved: gVisor DNS workarounds, host gateway resolution, volume mounts, extra_hosts, labels
- Synchronous Docker API calls wrapped in `run_in_executor` inside async methods
- Label-based orphan cleanup (`_cleanup_by_label`) maps to `cleanup_orphaned()`
- `create()` returns `SandboxInfo` (maps container_id -> sandbox_id, computes url internally)
- gVisor supported via `runtime="runsc"` (existing behavior)

Dependency: `docker` (already in pyproject.toml).

## K8sBackend

Uses `k8s-agent-sandbox` Python SDK (`SandboxClient`).

### Lifecycle mapping

| Operation | K8s SDK call | Notes |
|-----------|-------------|-------|
| Create | `SandboxClient.__aenter__()` | Creates Sandbox CR, waits for pod ready |
| Stop | `SandboxClient.__aexit__()` | Deletes Sandbox CR, controller cleans up pod |
| Cleanup orphaned | List Sandbox CRs by label | Find CRs not tracked in memory |
| Warm pool | `SandboxWarmPool` CR | Deployed separately, sub-second allocation |

### Communication

Same as Docker — backend POSTs to `{sandbox_url}/query`. The SDK's `sandbox.run()` is for shell commands; we use the sidecar's HTTP endpoint directly.

### gVisor support

Native via `runtimeClassName: gvisor` in the SandboxTemplate spec. Kata Containers also supported as an alternative.

### SandboxTemplate (deployed to cluster)

```yaml
apiVersion: extensions.agents.x-k8s.io/v1alpha1
kind: SandboxTemplate
metadata:
  name: duckdb-agent-sidecar
spec:
  podTemplate:
    metadata:
      labels:
        app: duckdb-agent-sidecar
    spec:
      runtimeClassName: gvisor
      containers:
      - name: sidecar
        image: duckdb-agent-sidecar:latest
        ports:
        - containerPort: 3000
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
        resources:
          requests:
            cpu: "250m"
            memory: "256Mi"
          limits:
            cpu: "500m"
            memory: "512Mi"
```

### Dependency

```toml
k8s-agent-sandbox = {version = "^0.1.1", optional = true}
```

## Config Changes

```python
# New
SANDBOX_RUNTIME = os.getenv("SANDBOX_RUNTIME", "docker")  # "docker" | "k8s"

# K8s-specific (only used when SANDBOX_RUNTIME="k8s")
K8S_TEMPLATE_NAME = os.getenv("K8S_TEMPLATE_NAME", "duckdb-agent-sidecar")
K8S_NAMESPACE = os.getenv("K8S_NAMESPACE", "default")
K8S_GATEWAY_NAME = os.getenv("K8S_GATEWAY_NAME", "")  # empty = tunnel/dev mode

# Existing Docker vars preserved as-is
CONTAINER_IMAGE, CONTAINER_RUNTIME, CONTAINER_MEMORY_LIMIT,
CONTAINER_CPU_LIMIT, CONTAINER_NETWORK, etc.
```

## Integration Points

### main.py

```python
from app.sandbox import get_sandbox_backend
sandbox_backend = get_sandbox_backend()
```

Lifespan and cleanup loop call `await sandbox_backend.xxx()` uniformly.

### agent.py

```python
from app.sandbox import get_sandbox_backend
sandbox_backend = get_sandbox_backend()
# await sandbox_backend.create(session_id, env)  — async for both backends
```

No more `run_in_executor` at the call site — each backend handles its own async wrapping.

## Deployment Matrix

| Environment | SANDBOX_RUNTIME | Requirements |
|-------------|-----------------|-------------|
| Local dev (macOS) | docker | Docker Desktop, `docker` Python package |
| Docker Compose | docker | Same as today, no changes |
| K8s dev (Kind/Minikube) | k8s | agent-sandbox controller + tunnel mode |
| K8s prod (GKE etc.) | k8s | agent-sandbox controller + gateway mode |

## Deployment Artifacts

```
deploy/
├── k8s/
│   ├── sandbox-template.yaml      # SandboxTemplate CR
│   └── warm-pool.yaml             # Optional SandboxWarmPool CR
├── helm/                          # Helm chart (adapted from opensandbox worktree)
└── kustomize/                     # Kustomize manifests (adapted)
```

## What Gets Removed (from opensandbox worktree)

- `sandbox/config.docker.toml`, `config.kubernetes.toml`, `config.dev.toml`
- `opensandbox` service from docker-compose.yml
- `opensandbox` Python dependency
- `backend/app/sandbox_manager.py`

## References

- [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
- [Python SDK](https://github.com/kubernetes-sigs/agent-sandbox/blob/main/clients/python/agentic-sandbox-client/README.md)
- [Agent Sandbox Docs](https://agent-sandbox.sigs.k8s.io/)
- [GKE Agent Sandbox Guide](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/agent-sandbox)
