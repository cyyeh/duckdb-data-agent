# K8s Deployment Guide

## Overview

The DuckDB Data Agent consists of four services:

- **Backend** (`duckdb-data-agent`) -- FastAPI application that serves the chat UI and orchestrates agent workflows.
- **Bifrost** (`maximhq/bifrost`) -- LLM gateway that proxies Anthropic API calls with caching and rate-limiting.
- **OpenSandbox** (`opensandbox/server`) -- Manages ephemeral sidecar containers for code execution. In Kubernetes mode it creates pods via the K8s API.
- **Sidecar** (`duckdb-agent-sidecar`) -- Short-lived containers spawned on demand by OpenSandbox to run SQL queries and user code in isolation.

## Prerequisites

- Kubernetes 1.24+
- Helm 3+ (for Helm deployment) and/or `kubectl` with kustomize (for Kustomize deployment)
- Container images pushed to a registry accessible from your cluster

## Kubernetes Deployment with Helm

```bash
# Build and push images to your registry
docker build -t YOUR_REGISTRY/duckdb-data-agent:latest -f backend/Dockerfile .
docker build -t YOUR_REGISTRY/duckdb-agent-sidecar:latest ./sidecar
docker push YOUR_REGISTRY/duckdb-data-agent:latest
docker push YOUR_REGISTRY/duckdb-agent-sidecar:latest

# Install the chart
helm install duckdb-agent deploy/helm/duckdb-data-agent \
  --set secrets.anthropicApiKey=sk-ant-... \
  --set backend.image.repository=YOUR_REGISTRY/duckdb-data-agent \
  --set backend.env.CONTAINER_IMAGE=YOUR_REGISTRY/duckdb-agent-sidecar:latest \
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
| `backend.image.repository` | `duckdb-data-agent` | Backend image |
| `backend.env.CONTAINER_IMAGE` | `duckdb-agent-sidecar:latest` | Sidecar image for OpenSandbox to spawn |
| `backend.env.SANDBOX_RUNTIME` | `kubernetes` | Sandbox runtime (`docker` or `kubernetes`) |
| `ingress.enabled` | `false` | Enable Ingress resource |
| `ingress.host` | `duckdb-agent.local` | Hostname for Ingress |
| `opensandbox.runtime` | `kubernetes` | OpenSandbox runtime type |
| `persistence.enabled` | `true` | Enable PVC for data storage |

## Kubernetes Deployment with Kustomize

```bash
# Build and push images to your registry (same as Helm)
docker build -t YOUR_REGISTRY/duckdb-data-agent:latest -f backend/Dockerfile .
docker build -t YOUR_REGISTRY/duckdb-agent-sidecar:latest ./sidecar
docker push YOUR_REGISTRY/duckdb-data-agent:latest
docker push YOUR_REGISTRY/duckdb-agent-sidecar:latest

# Create the secret for Bifrost
kubectl create secret generic bifrost-secret \
  --from-literal=ANTHROPIC_API_KEY=sk-ant-...

# Deploy all resources (Kubernetes runtime)
kubectl apply -k deploy/kustomize/overlays/kubernetes/

# Or for Docker-in-Docker runtime (testing only)
kubectl apply -k deploy/kustomize/overlays/docker/

# Verify
kubectl get pods
```

**Note:** Update the image references in `deploy/kustomize/base/backend-deployment.yaml` to point to your registry before applying.

The Kubernetes overlay generates an `opensandbox-config` ConfigMap from `config.kubernetes.toml` that sets the runtime to `kubernetes`.

## Configuration Reference

| Variable | Default | Description |
|---|---|---|
| `SANDBOX_RUNTIME` | `docker` | Sandbox runtime mode: `docker` or `kubernetes` |
| `OPENSANDBOX_DOMAIN` | `opensandbox:8080` | Host and port of the OpenSandbox server |
| `OPENSANDBOX_API_KEY` | (empty) | API key for OpenSandbox server (optional) |
| `CONTAINER_IMAGE` | `duckdb-agent-sidecar:latest` | Docker image used for sidecar containers |
| `CONTAINER_MEMORY_LIMIT` | `512m` | Memory limit per sidecar container |
| `CONTAINER_CPU_LIMIT` | `0.5` | CPU limit per sidecar container |
| `CONTAINER_MAX_LIFETIME_SECONDS` | `3600` | Max container lifetime before forced cleanup |
| `CONTAINER_IDLE_TIMEOUT_SECONDS` | `900` | Idle timeout before container is stopped |
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
- In K8s mode, ensure the sidecar image is accessible from the cluster (pushed to a registry).

**Sidecars can't reach Bifrost or backend (Docker mode)**
- Verify `sandbox/config.docker.toml` has `network_mode = "agent-sandbox"` (not `"bridge"`).
- Sidecars must be on the same Docker network as Bifrost and the backend.

**Network connectivity between services (K8s)**
- All services must be in the same namespace.
- The backend must be able to reach both Bifrost and OpenSandbox by hostname.
- Sidecars must be able to reach the backend at `BACKEND_BASE_URL` to report results.

**Bifrost not routing LLM requests**
- Ensure `ANTHROPIC_API_KEY` is set in the Bifrost secret/environment.
- Check Bifrost logs: `docker compose logs bifrost` or `kubectl logs deploy/bifrost`.
