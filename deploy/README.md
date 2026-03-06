# K8s Deployment Guide

## Overview

The DuckDB Data Agent consists of three services deployed on Kubernetes:

- **Backend** (`duckdb-data-agent-k8s`) — FastAPI application that serves the chat UI, orchestrates agent workflows, and manages sandbox lifecycle via the Kubernetes API.
- **Bifrost** (`maximhq/bifrost`) — LLM gateway that proxies Anthropic/OpenAI API calls with caching and rate-limiting.
- **Sidecar** (`duckdb-agent-sidecar`) — Ephemeral sandbox pods spawned on demand to run SQL queries and user code in isolation.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Kubernetes Cluster                                                 │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  agent-sandbox-system namespace                              │   │
│  │                                                              │   │
│  │  ┌────────────────────────────┐                              │   │
│  │  │  Agent Sandbox Controller  │  Watches SandboxClaims,      │   │
│  │  │  (StatefulSet)             │  creates Sandbox CRs,        │   │
│  │  │                            │  manages warm pool           │   │
│  │  └────────────────────────────┘                              │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  default namespace                                           │   │
│  │                                                              │   │
│  │  ┌──────────┐    LLM API     ┌──────────┐                    │   │
│  │  │ Backend  │───────────────▶│ Bifrost  │──▶ Anthropic/      │   │
│  │  │ (FastAPI)│                │ (Gateway)│    OpenAI APIs     │   │
│  │  └────┬─────┘                └──────────┘                    │   │
│  │       │                                                      │   │
│  │       │ 1. Create SandboxClaim (K8s API)                     │   │
│  │       │ 2. Watch Sandbox until Ready                         │   │
│  │       │ 3. Connect via headless Service DNS                  │   │
│  │       │                                                      │   │
│  │       │    ┌─────────────────────────────────────────┐       │   │
│  │       │    │  SandboxWarmPool                        │       │   │
│  │       │    │  (pre-warmed pods for fast allocation)  │       │   │
│  │       ▼    └─────────────────────────────────────────┘       │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐                    │   │
│  │  │ Sidecar  │  │ Sidecar  │  │ Sidecar  │  Ephemeral pods    │   │
│  │  │ Pod A    │  │ Pod B    │  │ Pod C    │  (1 per session)   │   │
│  │  └──────────┘  └──────────┘  └──────────┘                    │   │
│  │       ▲              ▲             ▲                         │   │
│  │       │              │             │                         │   │
│  │  sandbox-claim-*  (headless Services, auto-created)          │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### How It Works

1. **User sends a chat message** — Backend receives the request and needs a sandbox to execute code.

2. **Backend creates a SandboxClaim** — Uses the `k8s-agent-sandbox` SDK to create a `SandboxClaim` custom resource via the Kubernetes API, referencing the `SandboxTemplate` (`duckdb-agent-sidecar`).

3. **Controller fulfills the claim** — The Agent Sandbox Controller (running in `agent-sandbox-system` namespace) watches for new claims. If a `SandboxWarmPool` has pre-warmed pods available, it assigns one immediately; otherwise it creates a new pod from the template.

4. **Sandbox becomes ready** — The controller creates a `Sandbox` CR and a headless `Service` for the pod. The backend watches the `Sandbox` resource until its status is `Ready`.

5. **Backend connects to sidecar** — The backend resolves the sandbox endpoint via the headless service DNS (`sandbox-claim-<id>.default.svc.cluster.local:3000`) and communicates with the sidecar over HTTP (SSE streaming).

6. **Sidecar executes queries** — The sidecar runs the Claude Agent SDK, executes SQL queries against DuckDB via MCP, and streams results back to the backend.

7. **Cleanup** — When the session ends or expires, the backend deletes the `SandboxClaim`. The controller cleans up the pod and service via owner references. On startup, the backend also cleans up orphaned `SandboxClaim` resources left by previous backend pods.

### Key Resources

| Resource | API Group | Purpose |
|---|---|---|
| `SandboxTemplate` | `extensions.agents.x-k8s.io` | Pod template for sidecar containers |
| `SandboxWarmPool` | `extensions.agents.x-k8s.io` | Pre-warms pods for fast sandbox allocation (default: 2 replicas) |
| `SandboxClaim` | `extensions.agents.x-k8s.io` | Request for a sandbox (created by backend) |
| `Sandbox` | `agents.x-k8s.io` | Represents a running sandbox (created by controller) |

### RBAC

The backend pod runs with a dedicated `ServiceAccount` that has a `Role` granting:
- `create`, `get`, `list`, `watch`, `delete` on `sandboxclaims` (`extensions.agents.x-k8s.io`)
- `get`, `list`, `watch` on `sandboxes` (`agents.x-k8s.io`)
- `get`, `list`, `watch` on `pods` and `services` (core API)

### Sidecar Pod Security

Sidecar pods run with `readOnlyRootFilesystem: true` and drop all Linux capabilities. Writable storage is limited to two emptyDir volumes:

- `/home/appuser` — User home directory (required by the Claude CLI for `~/.claude.json` config and `~/.claude/` session data)
- `/tmp` — Temporary files

## Prerequisites

- Kubernetes 1.24+
- Helm 3+ (for Helm deployment) and/or `kubectl` with kustomize (for Kustomize deployment)
- Container images pushed to a registry accessible from your cluster
- [Agent Sandbox Controller](https://github.com/kubernetes-sigs/agent-sandbox) installed in the cluster

### Cluster Setup (one-time)

Install the agent-sandbox CRDs, controller, and project-specific resources:

```bash
# Install CRDs and controller
make k8s-setup

# Apply SandboxTemplate and WarmPool (done automatically by k8s-deploy)
make k8s-sandbox
```

This installs:
- The `SandboxTemplate`, `SandboxWarmPool`, `SandboxClaim` CRDs and controller (in `agent-sandbox-system` namespace)
- The `duckdb-agent-sidecar` SandboxTemplate (defines the sidecar pod spec)
- The `duckdb-agent-sidecar-pool` SandboxWarmPool (pre-warms 2 pods)

## Local Development (OrbStack / Docker Desktop)

OrbStack's built-in K8s can pull from a local registry at `localhost:5001` without extra configuration.

```bash
# Start a local registry (one-time)
make registry

# Build, push, and deploy in one step (opens port-forward automatically)
ANTHROPIC_API_KEY=sk-ant-... make k8s-deploy

# Or step by step:
make k8s-build    # build backend-k8s and sidecar images
make k8s-push     # push to local registry
make k8s-sandbox  # apply SandboxTemplate + WarmPool
helm upgrade --install duckdb-agent deploy/helm/duckdb-data-agent \
  --set secrets.anthropicApiKey=sk-ant-... \
  --set backend.image.repository=localhost:5001/duckdb-data-agent-k8s \
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

To tear down everything:

```bash
make k8s-delete
```

## Kubernetes Deployment with Helm

```bash
# Build and push images to your registry
docker build -t YOUR_REGISTRY/duckdb-data-agent-k8s:latest --build-arg SANDBOX_EXTRA=k8s -f backend/Dockerfile .
docker build -t YOUR_REGISTRY/duckdb-agent-sidecar:latest ./sidecar
docker push YOUR_REGISTRY/duckdb-data-agent-k8s:latest
docker push YOUR_REGISTRY/duckdb-agent-sidecar:latest

# Install the chart
helm install duckdb-agent deploy/helm/duckdb-data-agent \
  --set secrets.anthropicApiKey=sk-ant-... \
  --set backend.image.repository=YOUR_REGISTRY/duckdb-data-agent-k8s \
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
| `backend.image.repository` | `duckdb-data-agent-k8s` | Backend image |
| `backend.env.CONTAINER_IMAGE` | `duckdb-agent-sidecar:latest` | Sidecar image for sandbox pods |
| `backend.env.SANDBOX_RUNTIME` | `k8s` | Sandbox runtime (`docker` or `k8s`) |
| `backend.env.ORCHESTRATOR_MODEL` | `""` | Orchestrator model override |
| `backend.env.SQL_SUBAGENT_MODEL` | `""` | SQL sub-agent model override |
| `backend.env.DEFAULT_TOOL_MODEL` | `""` | Tool-calling model override |
| `ingress.enabled` | `false` | Enable Ingress resource |
| `ingress.host` | `duckdb-agent.local` | Hostname for Ingress |
| `persistence.enabled` | `true` | Enable PVC for data storage |

## Kubernetes Deployment with Kustomize

```bash
# Build and push images (use local registry or your own)
make k8s-push  # localhost:5001, or:
# REGISTRY=YOUR_REGISTRY make k8s-push

# Create the secret for Bifrost
kubectl create secret generic bifrost-secret \
  --from-literal=ANTHROPIC_API_KEY=sk-ant-...

# Deploy all resources (includes RBAC, backend, bifrost, services)
kubectl apply -k deploy/kustomize/overlays/kubernetes/

# Verify
kubectl get pods
```

**Note:** Update the image references in `deploy/kustomize/base/backend-deployment.yaml` to point to your registry before applying.

## Switching LLM Providers

The default configuration uses Anthropic via Bifrost. To use OpenAI or another provider, set the model env vars and the appropriate API key.

### Helm — using OpenAI

```bash
helm upgrade --install duckdb-agent deploy/helm/duckdb-data-agent \
  --set secrets.openaiApiKey=$OPENAI_API_KEY \
  --set backend.env.ORCHESTRATOR_MODEL="openai/gpt-5.2-2025-12-11@sonnet" \
  --set backend.env.SQL_SUBAGENT_MODEL="openai/gpt-5-mini-2025-08-07@haiku" \
  --set backend.env.DEFAULT_TOOL_MODEL="openai/gpt-5-mini-2025-08-07@haiku" \
  --set backend.image.repository=localhost:5001/duckdb-data-agent-k8s \
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
| `SANDBOX_RUNTIME` | `docker` | Sandbox runtime (`docker` or `k8s`) |
| `CONTAINER_IMAGE` | `duckdb-agent-sidecar:latest` | Docker image used for sidecar containers |
| `CONTAINER_MEMORY_LIMIT` | `512Mi` | Memory limit per sidecar container |
| `CONTAINER_CPU_LIMIT` | `0.5` | CPU limit per sidecar container |
| `CONTAINER_MAX_LIFETIME_SECONDS` | `3600` | Max container lifetime before forced cleanup |
| `CONTAINER_IDLE_TIMEOUT_SECONDS` | `900` | Idle timeout before container is stopped |
| `K8S_TEMPLATE_NAME` | `duckdb-agent-sidecar` | Name of the SandboxTemplate CR (K8s mode only) |
| `K8S_NAMESPACE` | `default` | Namespace for sandbox pods (K8s mode only) |
| `K8S_API_URL` | `http://unused-in-cluster` | Set to any value when in-cluster; the backend uses headless service DNS instead |
| `BIFROST_BASE_URL` | `http://bifrost:8080` | URL of the Bifrost LLM gateway |
| `BACKEND_BASE_URL` | `http://duckdb-data-agent:10000` | URL of the backend (used by sidecars to call back) |
| `ORCHESTRATOR_MODEL` | `claude-sonnet-4-6` | Model for the orchestrator agent |
| `SQL_SUBAGENT_MODEL` | `inherit` | Model for the SQL sub-agent |
| `DEFAULT_TOOL_MODEL` | (none) | Fallback model for tool-calling tasks |
| `SDK_IDLE_TIMEOUT_MS` | `600000` | Idle timeout (ms) for the Claude Agent SDK before aborting |
| `ANTHROPIC_API_KEY` | -- | Anthropic API key, consumed by Bifrost |
| `OPENAI_API_KEY` | -- | OpenAI API key (when using OpenAI models) |

## Troubleshooting

**Sidecar stream ended without result message**
- Check the sidecar pod's debug logs: `kubectl exec <pod> -- cat ~/.claude/debug/latest`
- Common cause: `readOnlyRootFilesystem` blocking writes to `~/.claude.json` or `/tmp`. Ensure the sandbox template mounts writable emptyDir volumes at `/home/appuser` and `/tmp`.
- The Claude CLI exits silently (code 0) when it cannot write its config file.

**Sidecar containers not being created**
- Check backend logs: `kubectl logs deploy/duckdb-agent-duckdb-data-agent-backend`
- Verify the agent-sandbox controller is running: `kubectl get pods -n agent-sandbox-system`
- Verify the SandboxTemplate exists: `kubectl get sandboxtemplates`
- Check SandboxClaim status: `kubectl get sandboxclaims -o yaml`

**Pre-warmed pool pods not being used**
- The pool pods have names like `duckdb-agent-sidecar-pool-*`. When a claim is fulfilled, one pod is assigned and a new one is created to replace it.
- Check which pod the claim is using: `kubectl get endpoints <claim-name>` and match the IP to `kubectl get pods -o wide`.
- The user may be looking at a replacement pool pod's logs instead of the claimed pod.

**Network connectivity between services**
- All services must be in the same namespace (default).
- The backend must be able to reach Bifrost by service name.
- Sidecars must be able to reach the backend at `BACKEND_BASE_URL` (set automatically by Helm to the backend service URL).
- Verify from sidecar: `kubectl exec <pod> -- curl -s http://duckdb-agent-duckdb-data-agent-backend:10000/api/health`

**Bifrost not routing LLM requests**
- Ensure `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) is set in the secret.
- Check Bifrost logs: `kubectl logs deploy/duckdb-agent-duckdb-data-agent-bifrost`
- Verify the configmap has the correct provider configuration: `kubectl get configmap duckdb-agent-duckdb-data-agent-bifrost -o yaml`

**Local registry not reachable from K8s pods**
- Ensure the registry container is running: `docker ps | grep registry`
- OrbStack and Docker Desktop K8s can reach `localhost:5001` natively.
- For other K8s distros, you may need to configure containerd to trust `localhost:5001` as an insecure registry.

**Orphaned SandboxClaims after backend restart**
- The backend cleans up orphaned claims on startup via `cleanup_orphaned()`.
- Manual cleanup: `kubectl delete sandboxclaims --all`
