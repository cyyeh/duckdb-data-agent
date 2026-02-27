import json
import logging

from fastapi import APIRouter, Request
from fastapi.responses import Response, StreamingResponse
import httpx

from app.config import MODEL_REWRITES, DEFAULT_TOOL_MODEL, BIFROST_BASE_URL

logger = logging.getLogger(__name__)

ANTHROPIC_UPSTREAM = BIFROST_BASE_URL + "/anthropic"

_SKIP_REQUEST_HEADERS = {
    "host", "content-length", "transfer-encoding", "connection",
}
_SKIP_RESPONSE_HEADERS = {"transfer-encoding", "content-encoding", "connection"}

router = APIRouter(prefix="/anthropic")


def rewrite_model_in_body(
    body: bytes, rewrites: dict[str, str], fallback: str = ""
) -> bytes:
    """Rewrite the 'model' field in a JSON body using the rewrites map.

    Matches if the model string equals or contains a rewrite key
    (e.g. 'sonnet' matches 'claude-sonnet-4-6').
    If no rewrite matches and a fallback is set, rewrites to the fallback.
    Returns the body unchanged if no match/fallback or if body is not valid JSON.
    """
    if not rewrites and not fallback:
        return body
    try:
        data = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return body
    model = data.get("model")
    if not model or not isinstance(model, str):
        return body
    for tier, real_model in rewrites.items():
        if model == tier or tier in model:
            data["model"] = real_model
            return json.dumps(data).encode()
    if fallback:
        data["model"] = fallback
        return json.dumps(data).encode()
    return body


@router.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def proxy_to_upstream(path: str, request: Request):
    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in _SKIP_REQUEST_HEADERS
    }

    body = await request.body()

    # Rewrite model on POST requests (messages, completions, etc.)
    if request.method == "POST" and (MODEL_REWRITES or DEFAULT_TOOL_MODEL):
        body = rewrite_model_in_body(body, MODEL_REWRITES, fallback=DEFAULT_TOOL_MODEL)

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

        # For error responses, read the full body and log it so we can
        # debug upstream failures (e.g. Anthropic API 400 errors).
        if upstream_resp.status_code >= 400:
            error_body = await upstream_resp.aread()
            await upstream_resp.aclose()
            await client.aclose()
            # Extract model from request for context
            req_model = ""
            try:
                req_data = json.loads(body)
                req_model = req_data.get("model", "")
            except Exception:
                pass
            print(
                f"[proxy] {upstream_resp.status_code} {request.method} /{path}"
                f" model={req_model}:"
                f" {error_body.decode('utf-8', errors='replace')[:2000]}",
                flush=True,
            )
            return Response(
                content=error_body,
                status_code=upstream_resp.status_code,
                headers=response_headers,
            )

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
