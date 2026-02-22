.PHONY: dev backend frontend install install-all install-backend install-frontend \
       sidecar-build sidecar-network sidecar-setup dev-all clean

# Run both backend and frontend concurrently
dev:
	@trap 'kill 0' EXIT; \
	cd backend && poetry run uvicorn app.main:app --reload --port 8000 & \
	cd frontend && npm run dev & \
	wait

# Run with containerized runtime (requires: make sidecar-setup)
dev-all:
	@trap 'kill 0' EXIT; \
	cd backend && CONTAINER_ENABLED=true PROXY_BASE_URL=http://host.docker.internal:8000 poetry run uvicorn app.main:app --reload --port 8000 & \
	cd frontend && npm run dev & \
	wait

backend:
	cd backend && poetry run uvicorn app.main:app --reload --port 8000

frontend:
	cd frontend && npm run dev

# Install all dependencies
install: install-backend install-frontend

# Install everything including sidecar (requires Docker)
install-all: install sidecar-setup

install-backend:
	cd backend && poetry install

install-frontend:
	cd frontend && npm install

# Sidecar (container isolation)
sidecar-build:
	cd sidecar && docker build -t duckdb-agent-sidecar:latest .

sidecar-network:
	./sidecar/setup-network.sh

sidecar-setup: sidecar-build sidecar-network

clean:
	rm -rf backend/.venv backend/__pycache__ backend/app/__pycache__ backend/app/routes/__pycache__
	rm -rf frontend/node_modules frontend/dist
	rm -rf sidecar/node_modules sidecar/dist
