# Stage 1: Build frontend
FROM node:20-slim AS frontend-build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/index.html frontend/vite.config.ts frontend/tsconfig.json frontend/tsconfig.app.json frontend/tsconfig.node.json ./
COPY frontend/src/ src/
COPY frontend/public/ public/
RUN npm run build

# Stage 2: Python backend
FROM python:3.12-slim
WORKDIR /app

# Install Node.js (required for Claude CLI)
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Claude CLI globally
RUN npm install -g @anthropic-ai/claude-code

RUN pip install --no-cache-dir poetry && \
    poetry config virtualenvs.create false

COPY backend/pyproject.toml backend/poetry.lock ./
RUN poetry install --no-root --no-interaction

COPY backend/app/ app/

# Copy built frontend into backend static directory
COPY --from=frontend-build /app/dist/ static/

# Create non-root user (Claude CLI refuses --dangerously-skip-permissions as root)
RUN useradd -m appuser
USER appuser

EXPOSE 10000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "10000"]
