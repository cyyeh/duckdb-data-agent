from fastapi import Header
from app.database import Database
from app.session_manager import session_manager


async def get_session_db(x_session_id: str = Header(...)) -> Database:
    return session_manager.get_or_create(x_session_id)
