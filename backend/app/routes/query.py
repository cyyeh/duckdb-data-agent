from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.database import db

router = APIRouter(prefix="/api", tags=["query"])


class QueryRequest(BaseModel):
    sql: str


@router.post("/query")
async def execute_query(request: QueryRequest):
    try:
        result = db.execute_query(request.sql)
        sql_lower = request.sql.strip().lower()
        result_type = "markdown" if sql_lower.startswith("explain") else "table"
        return {**result, "resultType": result_type}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
