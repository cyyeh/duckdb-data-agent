import logging
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
import httpx

from app.config import ANTHROPIC_API_KEY

logger = logging.getLogger(__name__)

ANTHROPIC_UPSTREAM = "https://api.anthropic.com"

_SKIP_REQUEST_HEADERS = {
    "host", "content-length", "transfer-encoding", "connection",
    "x-api-key",         # client must not override billing identity
    "anthropic-version", # proxy controls API version
    "anthropic-beta",    # proxy controls beta feature access
}
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
        # Tokens are intentionally multi-use: Claude Code makes many API calls
        # per session, all protected by the same UUID. The token is valid for
        # the session TTL (600s safety net) but is explicitly revoked by
        # proxy_token_store.revoke_token() in agent.py's finally block when
        # the Claude Code subprocess exits. Do not make single-use.
        expiry = self._tokens.get(token)
        if expiry is None:
            return False
        if datetime.now(timezone.utc) > expiry:
            self._tokens.pop(token, None)
            return False
        return True

    def revoke_token(self, token: str) -> None:
        self._tokens.pop(token, None)

    def cleanup_expired(self) -> int:
        now = datetime.now(timezone.utc)
        expired = [t for t, exp in self._tokens.items() if now > exp]
        for t in expired:
            del self._tokens[t]
        return len(expired)


proxy_token_store = ProxyTokenStore()

_http_client: httpx.AsyncClient | None = None


def get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(timeout=httpx.Timeout(300.0))
    return _http_client


async def close_http_client() -> None:
    global _http_client
    if _http_client is not None:
        await _http_client.aclose()
        _http_client = None


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
    headers["authorization"] = f"Bearer {ANTHROPIC_API_KEY}"

    body = await request.body()

    client = get_http_client()
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

        return StreamingResponse(
            body_generator(),
            status_code=upstream_resp.status_code,
            headers=response_headers,
        )
    except Exception:
        logger.exception("Proxy request to upstream failed: %s %s", request.method, path)
        raise
