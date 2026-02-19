import re

from fastapi import APIRouter, UploadFile, File, HTTPException

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
    table_name = sanitize_table_name(file.filename)
    result = db.load_csv(content, file.filename, table_name)
    return result


@router.post("/upload/sample")
async def load_sample():
    """Load the built-in Titanic sample dataset."""
    import urllib.request
    import tempfile
    import os

    sample_url = "https://raw.githubusercontent.com/datasciencedojo/datasets/master/titanic.csv"
    with tempfile.NamedTemporaryFile(suffix=".csv", delete=False) as tmp:
        urllib.request.urlretrieve(sample_url, tmp.name)
        tmp_path = tmp.name
    try:
        result = db.load_sample_data(tmp_path, "titanic")
    finally:
        os.unlink(tmp_path)
    return result


@router.delete("/tables/{table_name}")
async def drop_table(table_name: str):
    db.drop_table(table_name)
    return {"ok": True}
