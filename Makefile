.PHONY: dev backend frontend install install-backend install-frontend \
       sidecar-build sidecar-network clean compose-build compose-up compose-down \
       install-e2e e2e-test e2e-test-headed e2e-test-ui e2e-report \
       registry k8s-build k8s-push k8s-deploy k8s-delete \
       kustomize-deploy kustomize-delete k8s-setup

# Local container registry (OrbStack / Docker Desktop K8s)
REGISTRY ?= localhost:5001
BACKEND_IMAGE = $(REGISTRY)/duckdb-data-agent:latest
SIDECAR_IMAGE = $(REGISTRY)/duckdb-agent-sidecar:latest

# LLM provider and model configuration (override via env or command line)
ORCHESTRATOR_MODEL ?=
SQL_SUBAGENT_MODEL ?=
DEFAULT_TOOL_MODEL ?=

# Agent Sandbox CRD version (https://github.com/kubernetes-sigs/agent-sandbox/releases)
AGENT_SANDBOX_VERSION ?= v0.1.1

# Run Bifrost + OpenSandbox + backend + frontend concurrently (requires sidecar image built)
dev: sidecar-network
	@docker rm -f bifrost-dev opensandbox-dev 2>/dev/null || true; \
	docker run -d --name bifrost-dev \
		--network agent-sandbox \
		-p $${BIFROST_PORT:-8081}:8080 \
		-v $$(pwd)/bifrost/data:/app/data \
		-v $$(pwd)/bifrost/config.json:/app/data/config.json \
		--env-file backend/.env \
		-e APP_HOST=0.0.0.0 \
		maximhq/bifrost:latest && \
	echo "Bifrost started on port $${BIFROST_PORT:-8081}"; \
	docker run -d --name opensandbox-dev \
		--network agent-sandbox \
		-p $${OPENSANDBOX_PORT:-8082}:8080 \
		-v /var/run/docker.sock:/var/run/docker.sock \
		-v $$(pwd)/sandbox/config.dev.toml:/etc/opensandbox/config.toml \
		opensandbox/server:latest && \
	echo "OpenSandbox started on port $${OPENSANDBOX_PORT:-8082}"; \
	export BIFROST_BASE_URL=http://localhost:8081; \
	export BACKEND_BASE_URL=http://host.docker.internal:8000; \
	export OPENSANDBOX_DOMAIN=localhost:$${OPENSANDBOX_PORT:-8082}; \
	cd backend && poetry run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 & \
	BACKEND_PID=$$!; \
	echo "Waiting for backend on port 8000..."; \
	for i in $$(seq 1 30); do \
		curl -sf http://localhost:8000/api/health >/dev/null 2>&1 && break; \
		sleep 1; \
	done && echo "Backend ready" || { echo "Backend failed to start"; exit 1; }; \
	cd frontend && npm run dev & \
	trap 'wait $$BACKEND_PID 2>/dev/null; docker rm -f bifrost-dev opensandbox-dev 2>/dev/null; kill 0' EXIT; \
	wait

backend:
	cd backend && poetry run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

frontend:
	cd frontend && npm run dev

# Install all dependencies and set up sidecar
install: install-backend install-frontend sidecar-build sidecar-network install-e2e

install-backend:
	cd backend && poetry install

install-frontend:
	cd frontend && npm install

sidecar-build:
	docker build -t duckdb-agent-sidecar:latest ./sidecar

sidecar-network:
	./sidecar/setup-network.sh

# Docker Compose
compose-build:
	APP_UID=$$(id -u) docker compose --profile sidecar build

compose-up: sidecar-network
	@mkdir -p data
	docker compose up

compose-down:
	docker compose down

clean:
	rm -rf backend/.venv backend/__pycache__ backend/app/__pycache__ backend/app/routes/__pycache__
	rm -rf frontend/node_modules frontend/dist
	rm -rf sidecar/node_modules sidecar/dist
	rm -rf e2e/node_modules e2e/dist
	rm -f /tmp/duckdb-data-agent-*.duckdb /tmp/duckdb-data-agent-*.duckdb.wal

# ---------- K8s local deployment ----------

# Install agent-sandbox CRD and controller (one-time cluster setup)
k8s-setup:
	kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/$(AGENT_SANDBOX_VERSION)/manifest.yaml
	@echo "Waiting for agent-sandbox controller pods to be ready..."
	@for i in $$(seq 1 30); do \
		kubectl get pods -n agent-sandbox-system 2>/dev/null | grep -q Running && break; \
		sleep 2; \
	done
	kubectl -n agent-sandbox-system wait --for=condition=Ready pod --all --timeout=120s
	@echo "Agent-sandbox controller is ready"

# Start a local container registry (idempotent)
registry:
	@docker inspect registry >/dev/null 2>&1 \
		&& echo "Registry already running at $(REGISTRY)" \
		|| (docker run -d --restart=always -p 5001:5000 --name registry registry:2 \
			&& echo "Registry started at $(REGISTRY)")

# Build images tagged for the local registry
k8s-build:
	docker build -t $(BACKEND_IMAGE) -f backend/Dockerfile .
	docker build -t $(SIDECAR_IMAGE) ./sidecar

# Push images to the local registry
k8s-push: k8s-build
	docker push $(BACKEND_IMAGE)
	docker push $(SIDECAR_IMAGE)

# Deploy to K8s via Helm using the local registry
k8s-deploy: k8s-push k8s-setup
	helm upgrade --install duckdb-agent deploy/helm/duckdb-data-agent \
		--set backend.image.repository=$(REGISTRY)/duckdb-data-agent \
		--set backend.image.pullPolicy=Always \
		--set backend.env.CONTAINER_IMAGE=$(SIDECAR_IMAGE) \
		$(if $(ANTHROPIC_API_KEY),--set secrets.anthropicApiKey=$${ANTHROPIC_API_KEY}) \
		$(if $(OPENAI_API_KEY),--set secrets.openaiApiKey=$${OPENAI_API_KEY}) \
		$(if $(ORCHESTRATOR_MODEL),--set backend.env.ORCHESTRATOR_MODEL=$(ORCHESTRATOR_MODEL)) \
		$(if $(SQL_SUBAGENT_MODEL),--set backend.env.SQL_SUBAGENT_MODEL=$(SQL_SUBAGENT_MODEL)) \
		$(if $(DEFAULT_TOOL_MODEL),--set backend.env.DEFAULT_TOOL_MODEL=$(DEFAULT_TOOL_MODEL))
	@echo "Waiting for backend pod to be ready..."
	@kubectl wait --for=condition=Ready pod -l app.kubernetes.io/component=backend --timeout=120s
	@echo "Backend ready — forwarding localhost:8000 -> backend:10000"
	kubectl port-forward svc/duckdb-agent-duckdb-data-agent-backend 8000:10000

# Remove the Helm release, PVCs, and agent-sandbox controller
k8s-delete:
	helm uninstall duckdb-agent || true
	kubectl delete pvc -l app.kubernetes.io/instance=duckdb-agent || true
	kubectl delete -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/$(AGENT_SANDBOX_VERSION)/manifest.yaml || true

# Deploy to K8s via Kustomize using the local registry
kustomize-deploy: k8s-push k8s-setup
	@kubectl get secret bifrost-secret >/dev/null 2>&1 \
		|| (echo "Error: bifrost-secret not found. Create it with:" \
			&& echo "  kubectl create secret generic bifrost-secret --from-literal=ANTHROPIC_API_KEY=sk-ant-..." \
			&& exit 1)
	kubectl apply -k deploy/kustomize/overlays/kubernetes/
	@echo "Waiting for backend pod to be ready..."
	@kubectl wait --for=condition=Ready pod -l app=backend --timeout=120s
	@echo "Backend ready — forwarding localhost:8000 -> backend:10000"
	kubectl port-forward svc/backend 8000:10000

# Remove all Kustomize-deployed resources
kustomize-delete:
	kubectl delete -k deploy/kustomize/overlays/kubernetes/ || true
	kubectl delete -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/$(AGENT_SANDBOX_VERSION)/manifest.yaml || true

# E2E tests
install-e2e:
	cd e2e && npm install && npx playwright install chromium

e2e-test:
	cd e2e && npx playwright test

e2e-test-headed:
	cd e2e && npx playwright test --headed

e2e-test-ui:
	cd e2e && npx playwright test --ui

e2e-report:
	cd e2e && npx playwright show-report results
