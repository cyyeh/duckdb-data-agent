from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routes import tables, query, chat

app = FastAPI(title="DuckDB Data Agent API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(tables.router)
app.include_router(query.router)
app.include_router(chat.router)


@app.get("/api/health")
async def health():
    return {"status": "ok"}
