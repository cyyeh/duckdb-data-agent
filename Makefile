.PHONY: dev backend frontend install install-backend install-frontend clean

# Run both backend and frontend concurrently
dev:
	@trap 'kill 0' EXIT; \
	cd backend && poetry run uvicorn app.main:app --reload --port 8000 & \
	cd frontend && npm run dev & \
	wait

backend:
	cd backend && poetry run uvicorn app.main:app --reload --port 8000

frontend:
	cd frontend && npm run dev

# Install all dependencies
install: install-backend install-frontend

install-backend:
	cd backend && poetry install

install-frontend:
	cd frontend && npm install

clean:
	rm -rf backend/.venv backend/__pycache__ backend/app/__pycache__ backend/app/routes/__pycache__
	rm -rf frontend/node_modules frontend/dist
