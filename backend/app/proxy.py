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
    # anthropic-beta is intentionally NOT blocked: Claude Code sends beta body
    # fields (e.g. context_management) alongside the matching beta header, and
    # Anthropic rejects those fields as "extra inputs" if the header is absent.
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

router = APIRouter(prefix="/anthropic")


# Read-only discovery endpoints that the Claude Code SDK calls during startup
# (e.g. GET /v1/models to resolve short model aliases like "sonnet").
# These carry no session-specific data, so we forward them with the real API
# key without requiring a registered session token.
_UNAUTHENTICATED_PASSTHROUGH = {"v1/models"}


@router.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def proxy_anthropic(path: str, request: Request):
    # Allow a small set of read-only discovery endpoints to pass through
    # without a session token so the SDK can resolve short model names.
    if path not in _UNAUTHENTICATED_PASSTHROUGH:
        # Claude Code CLI sends the API key as x-api-key (Anthropic SDK default).
        # Fall back to Authorization: Bearer for other clients.
        session_token = (
            request.headers.get("x-api-key")
            or request.headers.get("authorization", "")[len("Bearer "):]
            or None
        )
        if not session_token or not proxy_token_store.validate_token(session_token):
            raise HTTPException(status_code=401, detail="Invalid or expired session token")

    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in _SKIP_REQUEST_HEADERS
    }
    headers["x-api-key"] = ANTHROPIC_API_KEY
    headers["anthropic-version"] = "2023-06-01"

    body = await request.body()

    # Use a fresh client per request: streaming responses that are cut short
    # (e.g. client disconnects) leave connections in a partial read state, and
    # reusing a shared SSL context across those connections causes
    # SSLV3_ALERT_BAD_RECORD_MAC / record layer failure errors.
    # Query params are intentionally NOT forwarded — Claude Code appends
    # internal params (e.g. ?beta=true) that Anthropic rejects as "extra inputs".
    client = httpx.AsyncClient(timeout=httpx.Timeout(300.0))
    try:
        upstream_req = client.build_request(
            method=request.method,
            url=f"{ANTHROPIC_UPSTREAM}/{path}",
            headers=headers,
            content=body,
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
        logger.exception("Proxy request to upstream failed: %s %s", request.method, path)
        raise
