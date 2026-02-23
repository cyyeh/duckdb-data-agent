import os

import duckdb
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from app.config import MAX_TOTAL_SIZE_BYTES
from app.database import Database, SUPPORTED_EXTENSIONS
from app.dependencies import get_session_db

router = APIRouter(prefix="/api", tags=["tables"])


def sanitize_table_name(filename: str) -> str:
    """Sanitize a filename into a safe SQL table name.

    Strips the extension, replaces non-alphanumeric characters with underscores,
    collapses consecutive underscores, and strips leading/trailing underscores.
    """
    import re
    name = os.path.splitext(filename)[0]
    name = re.sub(r"[^a-zA-Z0-9_]", "_", name)
    name = re.sub(r"_+", "_", name).strip("_")
    return name or "table"


@router.get("/tables")
async def list_tables(db: Database = Depends(get_session_db)):
    return await db.list_tables_async()


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
    # Check Content-Length header first to reject obviously oversized uploads
    # before reading the body into memory.
    if file.size is not None and file.size > MAX_TOTAL_SIZE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File size exceeds the {MAX_TOTAL_SIZE_BYTES // (1024 * 1024)}MB limit",
        )
    # Stream-read in chunks to enforce the limit without materializing the
    # entire file if it exceeds the cap.
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)  # 1 MB at a time
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_TOTAL_SIZE_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"File size exceeds the {MAX_TOTAL_SIZE_BYTES // (1024 * 1024)}MB limit",
            )
        chunks.append(chunk)
    content = b"".join(chunks)
    table_name = sanitize_table_name(file.filename)
    existing_tables = {t["name"] for t in await db.list_tables_async()}
    if table_name in existing_tables:
        raise HTTPException(
            status_code=409,
            detail=f"A table named \"{table_name}\" already exists. Please remove it or rename the file before uploading."
        )
    try:
        results = await db.load_file_async(content, file.filename, table_name)
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
    return await db.load_sample_data_async(str(csv_path), "titanic")


@router.delete("/tables/{table_name:path}")
async def drop_table(table_name: str, db: Database = Depends(get_session_db)):
    await db.drop_table_async(table_name)
    return {"ok": True}
