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
- [Agent Sandbox CRD](https://github.com/kubernetes-sigs/agent-sandbox) installed in the cluster (required by OpenSandbox)

### Cluster Setup (one-time)

Install the agent-sandbox CRD and controller:

```bash
make k8s-setup
```

This installs the `sandboxes.agents.x-k8s.io` CRD that OpenSandbox uses to create ephemeral sidecar pods.

## Local Development (OrbStack / Docker Desktop)

OrbStack's built-in K8s can pull from a local registry at `localhost:5001` without extra configuration.

```bash
# Start a local registry (one-time)
make registry

# Build, push, and deploy in one step
ANTHROPIC_API_KEY=sk-ant-... make k8s-deploy

# Or step by step:
make k8s-build    # build images tagged for localhost:5001
make k8s-push     # push to local registry
helm upgrade --install duckdb-agent deploy/helm/duckdb-data-agent \
  --set secrets.anthropicApiKey=sk-ant-... \
  --set backend.image.repository=localhost:5001/duckdb-data-agent \
  --set backend.image.pullPolicy=Always \
  --set backend.env.CONTAINER_IMAGE=localhost:5001/duckdb-agent-sidecar:latest

# Verify
kubectl get pods

# Access the web app locally
kubectl port-forward svc/duckdb-agent-duckdb-data-agent-backend 8000:10000
# Open http://localhost:8000
```

To use a different registry, override the `REGISTRY` variable:

```bash
REGISTRY=my-registry.example.com make k8s-push
```

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
| `secrets.anthropicApiKey` | `""` | Anthropic API key |
| `secrets.openaiApiKey` | `""` | OpenAI API key |
| `backend.image.repository` | `duckdb-data-agent` | Backend image |
| `backend.env.CONTAINER_IMAGE` | `duckdb-agent-sidecar:latest` | Sidecar image for OpenSandbox to spawn |
| `backend.env.SANDBOX_RUNTIME` | `kubernetes` | Sandbox runtime (`docker` or `kubernetes`) |
| `backend.env.ORCHESTRATOR_MODEL` | `""` | Orchestrator model override |
| `backend.env.SQL_SUBAGENT_MODEL` | `""` | SQL sub-agent model override |
| `backend.env.DEFAULT_TOOL_MODEL` | `""` | Tool-calling model override |
| `ingress.enabled` | `false` | Enable Ingress resource |
| `ingress.host` | `duckdb-agent.local` | Hostname for Ingress |
| `opensandbox.runtime` | `kubernetes` | OpenSandbox runtime type |
| `persistence.enabled` | `true` | Enable PVC for data storage |

## Kubernetes Deployment with Kustomize

```bash
# Build and push images (use local registry or your own)
make k8s-push  # localhost:5001, or:
# REGISTRY=YOUR_REGISTRY make k8s-push

# Create the secret for Bifrost
kubectl create secret generic bifrost-secret \
  --from-literal=ANTHROPIC_API_KEY=sk-ant-...

# Deploy all resources
kubectl apply -k deploy/kustomize/overlays/kubernetes/

# Verify
kubectl get pods
```

**Note:** Update the image references in `deploy/kustomize/base/backend-deployment.yaml` to point to your registry before applying.

The Kubernetes overlay generates an `opensandbox-config` ConfigMap from `config.kubernetes.toml` that sets the runtime to `kubernetes`.

## Switching LLM Providers

The default configuration uses Anthropic via Bifrost. To use OpenAI or another provider, set the model env vars and the appropriate API key.

### Helm — using OpenAI

```bash
helm upgrade --install duckdb-agent deploy/helm/duckdb-data-agent \
  --set secrets.openaiApiKey=$OPENAI_API_KEY \
  --set backend.env.ORCHESTRATOR_MODEL="openai/gpt-5.2-2025-12-11@sonnet" \
  --set backend.env.SQL_SUBAGENT_MODEL="openai/gpt-5-mini-2025-08-07@haiku" \
  --set backend.env.DEFAULT_TOOL_MODEL="openai/gpt-5-mini-2025-08-07@haiku" \
  --set backend.image.repository=localhost:5001/duckdb-data-agent \
  --set backend.env.CONTAINER_IMAGE=localhost:5001/duckdb-agent-sidecar:latest
```

### Kustomize — using OpenAI

Add the key to the secret:

```bash
kubectl create secret generic bifrost-secret \
  --from-literal=OPENAI_API_KEY=$OPENAI_API_KEY
```

Then create a kustomize patch (e.g. `deploy/kustomize/overlays/kubernetes/patches/openai-models.yaml`):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend
spec:
  template:
    spec:
      containers:
        - name: backend
          env:
            - name: ORCHESTRATOR_MODEL
              value: "openai/gpt-5.2-2025-12-11@sonnet"
            - name: SQL_SUBAGENT_MODEL
              value: "openai/gpt-5-mini-2025-08-07@haiku"
            - name: DEFAULT_TOOL_MODEL
              value: "openai/gpt-5-mini-2025-08-07@haiku"
```

The model format is `provider/model-id@tier` where `@tier` maps to the Bifrost routing tier.

## Configuration Reference

| Variable | Default | Description |
|---|---|---|
| `SANDBOX_RUNTIME` | `docker` | Sandbox runtime mode: `docker` or `kubernetes` |
| `OPENSANDBOX_DOMAIN` | `opensandbox:8080` | Host and port of the OpenSandbox server |
| `OPENSANDBOX_API_KEY` | (empty) | API key for OpenSandbox server (optional) |
| `CONTAINER_IMAGE` | `duckdb-agent-sidecar:latest` | Docker image used for sidecar containers |
| `CONTAINER_MEMORY_LIMIT` | `512Mi` | Memory limit per sidecar container |
| `CONTAINER_CPU_LIMIT` | `0.5` | CPU limit per sidecar container |
| `CONTAINER_MAX_LIFETIME_SECONDS` | `3600` | Max container lifetime before forced cleanup |
| `CONTAINER_IDLE_TIMEOUT_SECONDS` | `900` | Idle timeout before container is stopped |
| `BIFROST_BASE_URL` | `http://bifrost:8080` | URL of the Bifrost LLM gateway |
| `BACKEND_BASE_URL` | `http://duckdb-data-agent:10000` | URL of the backend (used by sidecars to call back) |
| `ORCHESTRATOR_MODEL` | (backend default) | Model for the orchestrator agent |
| `SQL_SUBAGENT_MODEL` | (backend default) | Model for the SQL sub-agent |
| `DEFAULT_TOOL_MODEL` | (backend default) | Model for tool-calling tasks |
| `ANTHROPIC_API_KEY` | -- | Anthropic API key, consumed by Bifrost |
| `OPENAI_API_KEY` | -- | OpenAI API key (when using OpenAI models) |

## Troubleshooting

**Sidecar containers not being created**
- Check OpenSandbox logs: `kubectl logs deploy/opensandbox`.
- Ensure the sidecar image is pushed to the registry and accessible from the cluster.
- Verify `CONTAINER_IMAGE` env var on the backend matches the pushed image tag.

**Network connectivity between services**
- All services must be in the same namespace.
- The backend must be able to reach both Bifrost and OpenSandbox by hostname.
- Sidecars must be able to reach the backend at `BACKEND_BASE_URL` to report results.

**Bifrost not routing LLM requests**
- Ensure `ANTHROPIC_API_KEY` is set in the Bifrost secret/environment.
- Check Bifrost logs: `kubectl logs deploy/bifrost`.

**Local registry not reachable from K8s pods**
- Ensure the registry container is running: `docker ps | grep registry`.
- OrbStack and Docker Desktop K8s can reach `localhost:5001` natively.
- For other K8s distros, you may need to configure containerd to trust `localhost:5001` as an insecure registry.
