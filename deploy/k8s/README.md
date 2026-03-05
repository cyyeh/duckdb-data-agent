# K8s Agent-Sandbox Deployment

Kubernetes manifests for deploying the DuckDB agent sidecar using the
[agent-sandbox](https://agent-sandbox.sigs.k8s.io/) controller.

## Prerequisites

- A Kubernetes cluster (v1.28+)
- The agent-sandbox controller installed in the cluster

## Install the agent-sandbox controller

```bash
kubectl apply \
  -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.1.1/manifest.yaml \
  -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.1.1/extensions.yaml
```

## Apply manifests

```bash
kubectl apply -f deploy/k8s/
```

This creates:

- **SandboxTemplate** (`sandbox-template.yaml`) -- defines the pod spec for
  each sidecar sandbox (gVisor runtime, read-only root filesystem, minimal
  capabilities).
- **SandboxWarmPool** (`warm-pool.yaml`) -- optional warm pool that keeps 2
  sandbox pods pre-provisioned for sub-second allocation.

## Backend configuration

Set the following environment variables on the backend to use the K8s sandbox
runtime:

| Variable | Description | Example |
|---|---|---|
| `SANDBOX_RUNTIME` | Must be `k8s` | `k8s` |
| `K8S_TEMPLATE_NAME` | Name of the SandboxTemplate | `duckdb-agent-sidecar` |
| `K8S_NAMESPACE` | Namespace where sandboxes run | `default` |
| `K8S_GATEWAY_NAME` | HTTPRoute gateway for sandbox access | `agent-gateway` |

## Warm pool

The warm pool (`warm-pool.yaml`) is optional. It keeps a configurable number of
sandbox pods already running so that new sessions can be assigned a pod almost
instantly instead of waiting for container startup. Adjust `spec.replicas` to
match your expected concurrency.

## Further reading

- Upstream documentation: <https://agent-sandbox.sigs.k8s.io/>
