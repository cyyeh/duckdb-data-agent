import os

import duckdb
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from app.config import MAX_TOTAL_SIZE_BYTES
from app.database import Database, SUPPORTED_EXTENSIONS
from app.dependencies import get_session_db

router = APIRouter(prefix="/api", tags=["tables"])


def sanitize_table_name(filename: str) -> str:
    return filename


@router.get("/tables")
async def list_tables(db: Database = Depends(get_session_db)):
    return db.list_tables()


@router.post("/upload")
async def upload_file(
    file: UploadFile = File(...),
    db: Database = Depends(get_session_db),
):
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
    try:
        results = db.load_file(content, file.filename, table_name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except duckdb.CatalogException:
        raise HTTPException(
            status_code=409,
            detail=f"A table named \"{table_name}\" already exists. Please remove it or rename the file before uploading."
        )
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Failed to process file: {e}")
    if len(results) == 1:
        return results[0]
    return results


@router.post("/upload/sample")
async def load_sample(db: Database = Depends(get_session_db)):
    """Load the built-in Titanic sample dataset."""
    from pathlib import Path

    csv_path = Path(__file__).resolve().parent.parent / "data" / "titanic.csv"
    if not csv_path.exists():
        raise HTTPException(status_code=404, detail="Sample dataset not found")
    return db.load_sample_data(str(csv_path), "titanic")


@router.delete("/tables/{table_name:path}")
async def drop_table(table_name: str, db: Database = Depends(get_session_db)):
    db.drop_table(table_name)
    return {"ok": True}
