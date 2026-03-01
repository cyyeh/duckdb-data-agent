# Stage 1: Build frontend
FROM node:20-slim AS frontend-build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/index.html frontend/vite.config.ts frontend/tsconfig.json frontend/tsconfig.app.json frontend/tsconfig.node.json ./
COPY frontend/src/ src/
RUN npm run build

# Stage 2: Python backend (no Claude CLI needed — sidecar handles agent execution)
FROM python:3.12-slim
WORKDIR /app

RUN pip install --no-cache-dir poetry && \
    poetry config virtualenvs.create false

COPY backend/pyproject.toml backend/poetry.lock ./
RUN poetry install --no-root --no-interaction --only main

COPY backend/app/ app/

# Copy built frontend into backend static directory
COPY --from=frontend-build /app/dist/ static/

ARG APP_UID=1000
RUN useradd -m -u ${APP_UID} appuser
USER appuser

EXPOSE 10000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "10000"]
