.PHONY: dev backend frontend install install-backend install-frontend \
       sidecar-build sidecar-network clean compose-build compose-up compose-down \
       install-e2e e2e-test e2e-report

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
	docker compose --profile sidecar build

compose-up: sidecar-network
	docker compose up

compose-down:
	docker compose down

clean:
	rm -rf backend/.venv backend/__pycache__ backend/app/__pycache__ backend/app/routes/__pycache__
	rm -rf frontend/node_modules frontend/dist
	rm -rf sidecar/node_modules sidecar/dist
	rm -rf e2e/node_modules e2e/dist
	rm -f /tmp/duckdb-data-agent-*.duckdb /tmp/duckdb-data-agent-*.duckdb.wal

# E2E tests
install-e2e:
	cd e2e && npm install && npx playwright install chromium

e2e-test:
	cd e2e && npx playwright test

e2e-report:
	cd e2e && npx playwright show-report results