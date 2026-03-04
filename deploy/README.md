# Deployment Guide

## Overview

The DuckDB Data Agent consists of four services:

- **Backend** (`duckdb-data-agent`) -- FastAPI application that serves the chat UI and orchestrates agent workflows.
- **Bifrost** (`maximhq/bifrost`) -- LLM gateway that proxies Anthropic API calls with caching and rate-limiting.
- **OpenSandbox** (`opensandbox/server`) -- Manages ephemeral sidecar containers for code execution. In Docker mode it talks to the Docker daemon; in Kubernetes mode it creates `agent-sandbox` CRD resources.
- **Sidecar** (`duckdb-agent-sidecar`) -- Short-lived containers spawned on demand by OpenSandbox to run SQL queries and user code in isolation.

## Prerequisites

### Docker deployment

- Docker Engine 20.10+
- docker-compose (v2 plugin or standalone)

### Kubernetes deployment

- Kubernetes 1.24+
- Helm 3+ (for Helm deployment) and/or `kubectl` with kustomize (for Kustomize deployment)
- `agent-sandbox` CRD installed in the cluster (required by OpenSandbox for K8s runtime)

## Docker Deployment

```bash
# Create the bridge network (required -- services reference it as external)
docker network create agent-sandbox

# Build all images including the sidecar
docker compose --profile sidecar build

# Start services (backend, bifrost, opensandbox)
docker compose up -d

# Verify
curl http://localhost:10000/api/health
```

The sidecar image is built but never started directly by Compose. The backend asks OpenSandbox to spawn sidecar containers on demand via the Docker socket.

Make sure `backend/.env` contains your `ANTHROPIC_API_KEY` -- Bifrost reads it from that env file.

## Kubernetes Deployment with Helm

```bash
# Install the agent-sandbox CRD (prerequisite for OpenSandbox K8s runtime)
# kubectl apply -f https://raw.githubusercontent.com/opensandbox/agent-sandbox/main/deploy/crd.yaml

# Install the chart
helm install duckdb-agent deploy/helm/duckdb-data-agent \
  --set secrets.anthropicApiKey=sk-ant-... \
  --set ingress.enabled=true \
  --set ingress.host=duckdb.example.com

# Verify
kubectl get pods
helm status duckdb-agent
```

Key Helm values (see `deploy/helm/duckdb-data-agent/values.yaml` for the full list):

| Value | Default | Description |
|---|---|---|
| `secrets.anthropicApiKey` | `""` | Anthropic API key (required) |
| `ingress.enabled` | `false` | Enable Ingress resource |
| `ingress.host` | `duckdb-agent.local` | Hostname for Ingress |
| `opensandbox.runtime` | `kubernetes` | Sandbox runtime (`docker` or `kubernetes`) |
| `persistence.enabled` | `true` | Enable PVC for data storage |

## Kubernetes Deployment with Kustomize

```bash
# Create the secret for Bifrost
kubectl create secret generic bifrost-secret \
  --from-literal=ANTHROPIC_API_KEY=sk-ant-...

# Deploy all resources
kubectl apply -k deploy/kustomize/overlays/kubernetes/

# Verify
kubectl get pods
```

The Kubernetes overlay generates an `opensandbox-config` ConfigMap from `config.kubernetes.toml` that sets the runtime to `kubernetes` with `agent-sandbox` as the workload provider.

## Configuration Reference

| Variable | Default | Description |
|---|---|---|
| `SANDBOX_RUNTIME` | `docker` | Sandbox runtime mode: `docker` or `kubernetes` |
| `OPENSANDBOX_DOMAIN` | `opensandbox:8080` | Host and port of the OpenSandbox server |
| `CONTAINER_IMAGE` | `duckdb-agent-sidecar:latest` | Docker image used for sidecar containers |
| `CONTAINER_MEMORY_LIMIT` | `512m` | Memory limit per sidecar container |
| `CONTAINER_CPU_LIMIT` | `1.0` | CPU limit per sidecar container |
| `BIFROST_BASE_URL` | `http://bifrost:8080` | URL of the Bifrost LLM gateway |
| `BACKEND_BASE_URL` | `http://duckdb-data-agent:10000` | URL of the backend (used by sidecars to call back) |
| `ANTHROPIC_API_KEY` | -- | Anthropic API key, consumed by Bifrost |

## Troubleshooting

**OpenSandbox server not starting (Docker mode)**
- Verify the Docker socket is mounted: the container needs `/var/run/docker.sock` access.
- Check that the user running Docker has permission to access the socket.
- Inspect logs: `docker compose logs opensandbox`.

**Sidecar containers not being created**
- Check OpenSandbox logs for errors: `docker compose logs opensandbox` or `kubectl logs deploy/opensandbox`.
- Confirm the sidecar image exists locally (`docker images | grep duckdb-agent-sidecar`).
- In Docker mode, ensure the `agent-sandbox` network exists: `docker network ls | grep agent-sandbox`.

**K8s: agent-sandbox CRD not installed**
- OpenSandbox will fail to create workloads if the CRD is missing. Install it before deploying.
- Verify: `kubectl get crd agentsandboxes.opensandbox.io` (or the appropriate CRD name).

**Network connectivity between services**
- All services must be on the same Docker network (`agent-sandbox`) or in the same K8s namespace.
- The backend must be able to reach both Bifrost and OpenSandbox by hostname.
- Sidecars must be able to reach the backend at `BACKEND_BASE_URL` to report results.
- Test with: `docker exec duckdb-data-agent curl http://bifrost:8080/health`.
