import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
import httpx

from app.config import CLAUDE_CODE_OAUTH_TOKEN

ANTHROPIC_UPSTREAM = "https://api.anthropic.com"

_SKIP_REQUEST_HEADERS = {"host", "content-length", "transfer-encoding", "connection"}
_SKIP_RESPONSE_HEADERS = {"transfer-encoding", "content-encoding", "connection"}


class ProxyTokenStore:
    def __init__(self, ttl_seconds: int = 600):
        self._ttl = ttl_seconds
        self._tokens: dict[str, datetime] = {}

    def create_token(self) -> str:
        token = str(uuid.uuid4())
        self._tokens[token] = datetime.now(timezone.utc) + timedelta(seconds=self._ttl)
        return token

    def validate_token(self, token: str) -> bool:
        expiry = self._tokens.get(token)
        if expiry is None:
            return False
        if datetime.now(timezone.utc) > expiry:
            self._tokens.pop(token, None)
            return False
        return True

    def revoke_token(self, token: str) -> None:
        self._tokens.pop(token, None)


proxy_token_store = ProxyTokenStore()

router = APIRouter(prefix="/anthropic")


@router.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def proxy_anthropic(path: str, request: Request):
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")

    session_token = auth_header[7:]
    if not proxy_token_store.validate_token(session_token):
        raise HTTPException(status_code=401, detail="Invalid or expired session token")

    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in _SKIP_REQUEST_HEADERS
    }
    headers["authorization"] = f"Bearer {CLAUDE_CODE_OAUTH_TOKEN}"

    body = await request.body()

    client = httpx.AsyncClient(timeout=httpx.Timeout(300.0))
    try:
        upstream_req = client.build_request(
            method=request.method,
            url=f"{ANTHROPIC_UPSTREAM}/{path}",
            headers=headers,
            content=body,
            params=dict(request.query_params),
        )
        upstream_resp = await client.send(upstream_req, stream=True)

        response_headers = {
            k: v for k, v in upstream_resp.headers.items()
            if k.lower() not in _SKIP_RESPONSE_HEADERS
        }

        async def body_generator():
            try:
                async for chunk in upstream_resp.aiter_bytes():
                    yield chunk
            finally:
                await upstream_resp.aclose()
                await client.aclose()

        return StreamingResponse(
            body_generator(),
            status_code=upstream_resp.status_code,
            headers=response_headers,
        )
    except Exception:
        await client.aclose()
        raise
