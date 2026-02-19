# Stage 1: Build frontend
FROM node:20-slim AS frontend-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY src/ src/
COPY public/ public/
RUN npm run build

# Stage 2: Python backend
FROM python:3.12-slim
WORKDIR /app

RUN pip install --no-cache-dir poetry && \
    poetry config virtualenvs.create false

COPY backend/pyproject.toml backend/poetry.lock ./
RUN poetry install --no-root --no-interaction

COPY backend/app/ app/

# Copy built frontend into backend static directory
COPY --from=frontend-build /app/dist/ static/

EXPOSE 10000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "10000"]
