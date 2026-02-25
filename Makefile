.PHONY: dev backend frontend install install-backend install-frontend \
       sidecar-build sidecar-network clean compose-build compose-up compose-down

# Run both backend and frontend concurrently (requires sidecar image built)
dev:
	@trap 'kill 0' EXIT; \
	cd backend && poetry run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 & \
	cd frontend && npm run dev & \
	wait

backend:
	cd backend && poetry run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

frontend:
	cd frontend && npm run dev

# Install all dependencies and set up sidecar
install: install-backend install-frontend sidecar-build sidecar-network

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
	docker compose build

compose-up: sidecar-network
	docker compose up

compose-down:
	docker compose down

clean:
	rm -rf backend/.venv backend/__pycache__ backend/app/__pycache__ backend/app/routes/__pycache__
	rm -rf frontend/node_modules frontend/dist
	rm -rf sidecar/node_modules sidecar/dist
