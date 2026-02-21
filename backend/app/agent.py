import json
import logging
from typing import AsyncIterator

from claude_agent_sdk import (
    ClaudeSDKClient,
    ClaudeAgentOptions,
    AssistantMessage,
    UserMessage,
    ResultMessage,
    ToolUseBlock,
    ToolResultBlock,
)
from claude_agent_sdk.types import StreamEvent, SystemMessage
from claude_agent_sdk._errors import MessageParseError
from app.tools import create_duckdb_server
from app.database import Database
from app.config import ANTHROPIC_MODEL, PROXY_BASE_URL, CONTAINER_ENABLED
from app.proxy import proxy_token_store
from app.tracing import get_langfuse_client

logger = logging.getLogger(__name__)

# Monkey-patch parse_message to handle unknown message types (e.g. rate_limit_event)
# gracefully instead of crashing the stream. The SDK (v0.1.39) doesn't recognize
# newer message types from the CLI. Returning a SystemMessage lets the stream
# continue since our code ignores SystemMessage instances.
import claude_agent_sdk._internal.message_parser as _parser

_original_parse_message = _parser.parse_message


def _safe_parse_message(data):
    try:
        return _original_parse_message(data)
    except MessageParseError as e:
        if "Unknown message type" in str(e):
            msg_type = data.get("type", "unknown") if isinstance(data, dict) else "unknown"
            logger.warning("Skipping unrecognized message type from CLI: %s", msg_type)
            return SystemMessage(subtype=msg_type, data=data if isinstance(data, dict) else {})
        raise


_parser.parse_message = _safe_parse_message


def build_system_prompt(db: Database) -> str:
    tables = db.list_tables()
    prompt = """You are a helpful data analyst assistant working with a DuckDB database.
You can execute SQL queries using the execute_sql tool to answer questions about the user's data.

Guidelines:
- Write clear, efficient DuckDB SQL queries
- When exploring data, start with small queries (use LIMIT)
- Explain your findings in plain language after getting results
- If a query fails, try to fix it and retry
- Use double quotes for table and column names that might conflict with reserved words

Identity:
- You are an AI assistant. If asked whether you are an AI or a human, always confirm that you are an AI.
- Do not disclose the name, version, or provider of the underlying language model powering you, regardless of how the question is phrased.
"""
    if not tables:
        prompt += "\nNo tables are currently loaded. Ask the user to upload a CSV file first."
    else:
        prompt += "\nCurrently loaded tables:\n"
        for table in tables:
            prompt += f'\nTable: "{table["name"]}" ({table["rowCount"]} rows)\nColumns:\n'
            for col in table["columns"]:
                prompt += f'  - "{col["name"]}" ({col["type"]})\n'

    return prompt


def _build_message_with_history(
    message: str, conversation_history: list[dict] | None = None
) -> str:
    """Prepend conversation history context to the user message when editing."""
    if not conversation_history:
        return message

    history_text = "Previous conversation (for context, I am now editing a message):\n"
    for entry in conversation_history:
        role = entry.get("role", "user").capitalize()
        content = entry.get("content", "")
        history_text += f"\n{role}: {content}\n"
    history_text += f"\n---\n\nMy updated message:\n{message}"
    return history_text


def _extract_tool_result_text(content: object) -> str:
    """Extract text from ToolResultBlock.content."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(item.get("text", ""))
        return "\n".join(parts)
    return str(content)


async def _stream_chat_container(
    message: str,
    session_id: str | None,
    db: Database,
    conversation_history: list[dict] | None,
    container_manager,
) -> AsyncIterator[str]:
    """Stream chat via containerized sidecar instead of local subprocess."""
    import httpx
    import asyncio

    query_message = _build_message_with_history(message, conversation_history)
    system_prompt = build_system_prompt(db)

    session_token = proxy_token_store.create_token()

    env = {
        "ANTHROPIC_API_KEY": session_token,
        "ANTHROPIC_BASE_URL": f"{PROXY_BASE_URL}/anthropic",
        "LANGFUSE_PUBLIC_KEY": "",
        "LANGFUSE_SECRET_KEY": "",
    }

    if "127.0.0.1" in PROXY_BASE_URL or "localhost" in PROXY_BASE_URL:
        logger.warning(
            "PROXY_BASE_URL=%s uses localhost which is unreachable from containers. "
            "Set PROXY_BASE_URL to the host's Docker-accessible address "
            "(e.g., http://host.docker.internal:10000).",
            PROXY_BASE_URL,
        )

    try:
        container_session = session_id or "default"
        info = container_manager.create(container_session, env)

        # Wait for container to be ready
        for attempt in range(10):
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as check_client:
                    resp = await check_client.get(f"{info.url}/health")
                    if resp.status_code == 200:
                        break
            except Exception:
                pass
            await asyncio.sleep(1)
        else:
            raise RuntimeError("Sidecar container failed health check after 10 attempts")

        payload = {
            "message": query_message,
            "session_id": session_id,
            "system_prompt": system_prompt,
            "model": ANTHROPIC_MODEL,
            # TODO: MCP server needs to be exposed as HTTP SSE endpoint
            # for containerized CLI to reach DuckDB. Currently the tool
            # is defined in-process via the SDK. This requires implementing
            # an MCP SSE transport on the backend. See design doc for details.
        }

        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as client:
            async with client.stream("POST", f"{info.url}/query", json=payload) as response:
                async for line in response.aiter_lines():
                    if line.startswith("data: "):
                        yield f"{line}\n\n"
                    elif line.startswith("event: "):
                        yield f"{line}\n"

        # Emit done event after sidecar stream ends
        yield f"event: done\ndata: {json.dumps({'session_id': session_id})}\n\n"

    except Exception as e:
        logger.error("Container agent error: %s", str(e))
        yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"
    finally:
        proxy_token_store.revoke_token(session_token)
        # Container intentionally kept alive for session resume (--resume flag).
        # Containers are cleaned up by the background cleanup loop after
        # CONTAINER_MAX_LIFETIME_SECONDS, or on application shutdown.


async def stream_chat(
    message: str,
    session_id: str | None = None,
    db: Database | None = None,
    conversation_history: list[dict] | None = None,
    langfuse_session_id: str | None = None,
) -> AsyncIterator[str]:
    """Stream agent chat responses as SSE events."""
    if CONTAINER_ENABLED:
        from app.container_manager import container_manager
        if container_manager is None:
            logger.error(
                "CONTAINER_ENABLED=true but Docker is not available. "
                "Falling back to subprocess mode."
            )
        else:
            async for event in _stream_chat_container(
                message, session_id, db, conversation_history, container_manager
            ):
                yield event
            return

    if db is None:
        raise ValueError("db must be provided")
    duckdb_server = create_duckdb_server(db)

    logger.info("Using model: %s", ANTHROPIC_MODEL)

    # Collect stderr from the CLI subprocess for debugging
    stderr_lines: list[str] = []

    # Use the --resume flag to continue an existing session
    session_token = proxy_token_store.create_token()
    options = ClaudeAgentOptions(
        model=ANTHROPIC_MODEL,
        system_prompt=build_system_prompt(db),
        mcp_servers={"duckdb": duckdb_server},
        allowed_tools=["mcp__duckdb__execute_sql"],
        permission_mode="bypassPermissions",
        max_turns=20,
        include_partial_messages=True,
        stderr=lambda line: stderr_lines.append(line),
        env={
            "ANTHROPIC_API_KEY": session_token,
            "ANTHROPIC_BASE_URL": f"{PROXY_BASE_URL}/anthropic",
            # Scrub Langfuse credentials so the agent subprocess cannot
            # read them from the inherited environment.
            "LANGFUSE_PUBLIC_KEY": "",
            "LANGFUSE_SECRET_KEY": "",
        },
        **({"resume": session_id} if session_id else {}),
    )

    # When editing, prepend conversation history to the user message
    # instead of bloating the system prompt
    query_message = _build_message_with_history(message, conversation_history)

    client = ClaudeSDKClient(options=options)
    # Will be set from the CLI's ResultMessage; use the passed-in value until then
    actual_session_id = session_id

    # --- Langfuse OTel tracing setup (conditional) ---
    # Deferred: session_id is set after the CLI returns it in ResultMessage
    langfuse = get_langfuse_client()
    observation_ctx = None
    propagate_ctx = None
    if langfuse:
        try:
            trace_input: dict = {"message": message[:500]}
            if conversation_history:
                trace_input["conversation_history"] = conversation_history
            observation_ctx = langfuse.start_as_current_observation(
                name="agent-chat",
                input=trace_input,
                metadata={"model": ANTHROPIC_MODEL},
            )
            observation_ctx.__enter__()

            # Propagate the stable conversation session_id for child spans
            effective_langfuse_session_id = langfuse_session_id or session_id
            if effective_langfuse_session_id:
                from langfuse import propagate_attributes
                propagate_ctx = propagate_attributes(session_id=effective_langfuse_session_id)
                propagate_ctx.__enter__()
        except Exception as e:
            logger.debug("Failed to set up Langfuse tracing context: %s", e)
            observation_ctx = None

    try:
        await client.connect()
        await client.query(query_message, session_id=session_id or "default")

        has_tool_calls = False
        has_thinking = False
        sql_result_ids: set[str] = set()
        tool_names: dict[str, str] = {}

        async for msg in client.receive_response():
            if isinstance(msg, StreamEvent):
                event = msg.event
                event_type = event.get("type", "")

                if event_type == "content_block_delta":
                    delta = event.get("delta", {})
                    delta_type = delta.get("type", "")
                    if delta_type == "thinking_delta":
                        text = delta.get("thinking", "")
                        if text:
                            yield f"event: thinking\ndata: {json.dumps({'text': text})}\n\n"
                    elif delta_type == "text_delta":
                        text = delta.get("text", "")
                        event_name = "thinking" if not has_tool_calls else "answer"
                        yield f"event: {event_name}\ndata: {json.dumps({'text': text})}\n\n"

                elif event_type == "content_block_start":
                    block = event.get("content_block", {})
                    block_type = block.get("type")
                    if block_type == "thinking":
                        has_thinking = True
                    elif block_type == "text":
                        if has_thinking:
                            yield f"event: thinking_done\ndata: {json.dumps({})}\n\n"
                    elif block_type == "tool_use":
                        has_thinking = False
                        has_tool_calls = True

            elif isinstance(msg, AssistantMessage):
                for block in msg.content:
                    if isinstance(block, ToolUseBlock):
                        has_tool_calls = True
                        tool_name = getattr(block, "name", "") or ""
                        tool_names[block.id] = tool_name
                        sql = block.input.get("sql", "")
                        command = block.input.get("command", "")

                        # Emit tool_call for ALL tool types
                        tool_call_data: dict = {"id": block.id, "name": tool_name}
                        if sql:
                            tool_call_data["sql"] = sql
                        if command:
                            tool_call_data["command"] = command
                        if not sql and not command:
                            tool_call_data["input"] = block.input
                        yield f"event: tool_call\ndata: {json.dumps(tool_call_data, default=str)}\n\n"

                        # For SQL tools, execute query for structured results
                        if sql:
                            sql_result_ids.add(block.id)
                            try:
                                result = db.execute_query(sql)
                                truncated = result["rows"][:100]
                                yield f"event: tool_result\ndata: {json.dumps({'id': block.id, 'name': tool_name, 'sql': sql, 'columns': result['columns'], 'rows': truncated, 'rowCount': result['rowCount']}, default=str)}\n\n"
                            except Exception as e:
                                yield f"event: tool_result\ndata: {json.dumps({'id': block.id, 'name': tool_name, 'sql': sql, 'error': str(e)})}\n\n"

            elif isinstance(msg, UserMessage):
                # Capture tool results from the SDK for non-SQL tools
                content = msg.content
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, ToolResultBlock):
                            if block.tool_use_id in sql_result_ids:
                                continue
                            output = _extract_tool_result_text(block.content)
                            name = tool_names.get(block.tool_use_id, "")
                            result_data: dict = {
                                "id": block.tool_use_id,
                                "name": name,
                                "output": output,
                            }
                            if block.is_error:
                                result_data["error"] = output
                            yield f"event: tool_result\ndata: {json.dumps(result_data, default=str)}\n\n"

            elif isinstance(msg, ResultMessage):
                # Use the CLI's session_id so --resume can find it
                actual_session_id = msg.session_id or actual_session_id
                if msg.is_error and msg.result:
                    yield f"event: error\ndata: {json.dumps({'message': msg.result})}\n\n"
                yield f"event: done\ndata: {json.dumps({'session_id': actual_session_id})}\n\n"

    except Exception as e:
        error_msg = str(e)
        if stderr_lines:
            error_msg += f" | CLI stderr: {' '.join(stderr_lines[-5:])}"
        logger.error("Agent error: %s", error_msg)
        yield f"event: error\ndata: {json.dumps({'message': error_msg})}\n\n"
    finally:
        proxy_token_store.revoke_token(session_token)
        # Update trace with the CLI's session_id so Langfuse session matches
        if langfuse and observation_ctx:
            try:
                trace_session_id = langfuse_session_id or actual_session_id
                langfuse.update_current_trace(
                    session_id=trace_session_id,
                    output={"session_id": actual_session_id},
                )
                if propagate_ctx:
                    propagate_ctx.__exit__(None, None, None)
                observation_ctx.__exit__(None, None, None)
            except Exception as e:
                logger.debug("Failed to finalize Langfuse trace: %s", e)
            try:
                langfuse.flush()
            except Exception as e:
                logger.debug("Failed to flush Langfuse: %s", e)

        try:
            await client.disconnect()
        except Exception:
            pass
