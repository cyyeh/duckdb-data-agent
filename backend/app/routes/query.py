from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.database import Database
from app.dependencies import get_session_db

router = APIRouter(prefix="/api", tags=["query"])


class QueryRequest(BaseModel):
    sql: str


@router.post("/query")
async def execute_query(
    request: QueryRequest,
    db: Database = Depends(get_session_db),
):
    try:
        result = db.execute_query(request.sql)
        sql_lower = request.sql.strip().lower()
        result_type = "markdown" if sql_lower.startswith("explain") else "table"
        return {**result, "resultType": result_type}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
