import re

from fastapi import APIRouter, UploadFile, File, HTTPException

from app.config import MAX_TOTAL_SIZE_BYTES
from app.database import db

router = APIRouter(prefix="/api", tags=["tables"])


def sanitize_table_name(filename: str) -> str:
    base = re.sub(r"\.csv$", "", filename, flags=re.IGNORECASE)
    sanitized = re.sub(r"[^a-z0-9_]", "_", base.lower())
    sanitized = re.sub(r"^[^a-z]", lambda m: "t_" + m.group(), sanitized)
    sanitized = re.sub(r"_+", "_", sanitized).rstrip("_")
    return sanitized or "table"


@router.get("/tables")
async def list_tables():
    return db.list_tables()


@router.post("/upload")
async def upload_csv(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Only CSV files are supported")
    content = await file.read()
    if len(content) > MAX_TOTAL_SIZE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File size exceeds the {MAX_TOTAL_SIZE_BYTES // (1024 * 1024)}MB limit"
        )
    table_name = sanitize_table_name(file.filename)
    result = db.load_csv(content, file.filename, table_name)
    return result


@router.post("/upload/sample")
async def load_sample():
    """Load the built-in Titanic sample dataset."""
    from pathlib import Path

    csv_path = Path(__file__).resolve().parent.parent / "data" / "titanic.csv"
    if not csv_path.exists():
        raise HTTPException(status_code=404, detail="Sample dataset not found")
    return db.load_sample_data(str(csv_path), "titanic")


@router.delete("/tables/{table_name}")
async def drop_table(table_name: str):
    db.drop_table(table_name)
    return {"ok": True}
