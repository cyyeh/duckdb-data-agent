# OpenSandbox Integration Design

## Date: 2026-03-04

## Goal

Replace the custom `ContainerManager` (Docker SDK) with [OpenSandbox](https://github.com/alibaba/OpenSandbox) for container lifecycle management. Add Kubernetes as a deployment target alongside Docker. Users can deploy the full system on either Docker or Kubernetes.

## Decision Record

- **Approach**: Full OpenSandbox — use OpenSandbox for both Docker and K8s runtimes
- **Integration mode**: Library mode — import OpenSandbox's runtime classes directly into the backend process, no separate OpenSandbox server container
- **Sidecar**: Keep the custom TypeScript Agent SDK sidecar as-is; OpenSandbox manages its lifecycle only
- **K8s packaging**: Both Helm charts and Kustomize manifests
- **Communication**: Backend still POSTs to sidecar's `/query` endpoint; agent logic unchanged

## Architecture

### Current

```
Frontend -> Backend (FastAPI) -> [Docker SDK] -> Sidecar Container (Agent SDK)
                                |
                           MCP SSE (/mcp)
```

### Proposed

```
Frontend -> Backend (FastAPI) -> [OpenSandbox SDK] -> Docker or K8s runtime -> Sidecar Container
                                |
                           MCP SSE (/mcp)
```

Key changes:
- Backend replaces direct Docker SDK calls with OpenSandbox Python SDK
- OpenSandbox runs as a library within the backend (no separate server)
- Config toggle (`SANDBOX_RUNTIME=docker|kubernetes`) selects runtime
- Sidecar image and `/query` communication path are unchanged

## Component Changes

### Backend

**`backend/app/sandbox_manager.py`** (new, replaces `container_manager.py`):
- Wraps OpenSandbox Python SDK for both Docker and K8s runtimes
- Same interface: `create()`, `get()`, `stop()`, `cleanup_expired()`, `shutdown_all()`
- Uses `Sandbox.create()` with the custom sidecar image
- Resolves sidecar endpoint URL via OpenSandbox's endpoint API
- Backend still POSTs to sidecar's `/query` directly

**`backend/app/config.py`** additions:
```python
SANDBOX_RUNTIME = os.getenv("SANDBOX_RUNTIME", "docker")  # "docker" or "kubernetes"
OPENSANDBOX_DOMAIN = os.getenv("OPENSANDBOX_DOMAIN", "localhost:8080")
OPENSANDBOX_API_KEY = os.getenv("OPENSANDBOX_API_KEY", "")
K8S_NAMESPACE = os.getenv("K8S_NAMESPACE", "default")
K8S_WORKLOAD_PROVIDER = os.getenv("K8S_WORKLOAD_PROVIDER", "agent-sandbox")
```

**`backend/app/container_manager.py`**: Removed after migration.

**`backend/app/main.py`**: Replace `container_manager` import with `sandbox_manager`.

### Docker Compose

Add OpenSandbox server as a service:
```yaml
opensandbox:
  image: opensandbox/server:latest
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock
    - ./sandbox/config.toml:/root/.sandbox.toml
  networks:
    - agent-sandbox
```

Backend service drops Docker socket mount, adds `OPENSANDBOX_DOMAIN=opensandbox:8080`.

### OpenSandbox Config

**`sandbox/config.toml`**:
```toml
[server]
host = "0.0.0.0"
port = 8080

[runtime]
type = "docker"
execd_image = "opensandbox/execd:v1.0.6"

[docker]
network_mode = "bridge"
drop_capabilities = ["ALL"]
no_new_privileges = true
pids_limit = 256
```

### Kubernetes Manifests

**`deploy/helm/`** — Helm chart:
- Backend deployment + service
- Bifrost deployment + service
- OpenSandbox server deployment + service (in-cluster K8s auth)
- ConfigMaps, Secrets, Ingress
- Values for resource limits, image tags, runtime config

**`deploy/kustomize/`** — Kustomize:
- `base/` — core manifests
- `overlays/docker/` — docker-in-docker testing
- `overlays/kubernetes/` — production K8s with agent-sandbox CRD

## Data Flow

### Sandbox Creation (Docker)

1. User sends first message, backend receives chat request
2. Backend checks if sandbox exists for session_id
3. Calls OpenSandbox SDK: `Sandbox.create(image="duckdb-agent-sidecar:latest", ...)`
4. OpenSandbox creates container via Docker runtime
5. Backend resolves sidecar endpoint URL from sandbox
6. Backend POSTs `/query` to sidecar (unchanged)
7. Sidecar streams SSE response back

### Sandbox Creation (Kubernetes)

1-2. Same as Docker
3. Backend calls OpenSandbox SDK with K8s-configured server
4. OpenSandbox creates pod via agent-sandbox CRD
5. Backend resolves sidecar endpoint via K8s service/pod IP
6-7. Same as Docker

### Sandbox Cleanup

OpenSandbox handles TTL-based expiration via the `timeout` parameter on `Sandbox.create()`. Backend's cleanup polling can be simplified or removed.

### Graceful Shutdown

On backend shutdown: list all sandboxes with label `app=duckdb-agent-sidecar`, call `sandbox.kill()` for each.

## Error Handling

| Scenario | Handling |
|----------|----------|
| OpenSandbox server unreachable | Backend returns 503 |
| Sandbox creation fails | Retry once, then error to user |
| Sidecar `/query` unreachable | Check sandbox health, recreate if needed |
| K8s pod eviction | OpenSandbox detects, backend creates new sandbox |
| OpenSandbox server crashes | Backend detects on next request |

## Migration Path

1. Add `opensandbox` to `requirements.txt`
2. Create `sandbox_manager.py` with same interface as `ContainerManager`
3. Update `main.py` to use new manager
4. Update `docker-compose.yml` to add OpenSandbox service
5. Add `sandbox/config.toml`
6. Add K8s manifests (`deploy/helm/`, `deploy/kustomize/`)
7. Remove `container_manager.py`

## Testing

- **Unit**: Mock OpenSandbox SDK, test sandbox manager logic
- **Integration (Docker)**: Full chat flow with OpenSandbox + sidecar
- **Integration (K8s)**: Use `kind` for local K8s testing
- **E2E**: Existing Playwright tests should pass unchanged

## Files Changed

| File | Action |
|------|--------|
| `backend/app/sandbox_manager.py` | Create |
| `backend/app/config.py` | Edit |
| `backend/app/main.py` | Edit |
| `backend/app/container_manager.py` | Delete |
| `backend/requirements.txt` | Edit |
| `docker-compose.yml` | Edit |
| `sandbox/config.toml` | Create |
| `deploy/helm/Chart.yaml` | Create |
| `deploy/helm/values.yaml` | Create |
| `deploy/helm/templates/*.yaml` | Create |
| `deploy/kustomize/base/*.yaml` | Create |
| `deploy/kustomize/overlays/docker/*.yaml` | Create |
| `deploy/kustomize/overlays/kubernetes/*.yaml` | Create |
