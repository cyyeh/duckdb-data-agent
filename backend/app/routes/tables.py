import os
import re

from fastapi import APIRouter, UploadFile, File, HTTPException

from app.config import MAX_TOTAL_SIZE_BYTES
from app.database import db, SUPPORTED_EXTENSIONS

router = APIRouter(prefix="/api", tags=["tables"])


def sanitize_table_name(filename: str) -> str:
    base = re.sub(r"\.(csv|json|parquet|xlsx|xls)$", "", filename, flags=re.IGNORECASE)
    sanitized = re.sub(r"[^a-z0-9_]", "_", base.lower())
    sanitized = re.sub(r"^[^a-z]", lambda m: "t_" + m.group(), sanitized)
    sanitized = re.sub(r"_+", "_", sanitized).rstrip("_")
    return sanitized or "table"


@router.get("/tables")
async def list_tables():
    return db.list_tables()


@router.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file format. Supported: {', '.join(sorted(SUPPORTED_EXTENSIONS))}"
        )
    content = await file.read()
    if len(content) > MAX_TOTAL_SIZE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File size exceeds the {MAX_TOTAL_SIZE_BYTES // (1024 * 1024)}MB limit"
        )
    table_name = sanitize_table_name(file.filename)
    results = db.load_file(content, file.filename, table_name)
    if len(results) == 1:
        return results[0]
    return results


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
