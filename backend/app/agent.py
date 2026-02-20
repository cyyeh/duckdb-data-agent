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
from claude_agent_sdk.types import StreamEvent
from app.tools import create_duckdb_server
from app.database import db
from app.config import ANTHROPIC_MODEL
from app.tracing import get_langfuse_client

logger = logging.getLogger(__name__)


def build_system_prompt() -> str:
    tables = db.list_tables()
    prompt = """You are a helpful data analyst assistant working with a DuckDB database.
You can execute SQL queries using the execute_sql tool to answer questions about the user's data.

Guidelines:
- Write clear, efficient DuckDB SQL queries
- When exploring data, start with small queries (use LIMIT)
- Explain your findings in plain language after getting results
- If a query fails, try to fix it and retry
- Use double quotes for table and column names that might conflict with reserved words
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


async def stream_chat(message: str, session_id: str | None = None) -> AsyncIterator[str]:
    """Stream agent chat responses as SSE events."""
    duckdb_server = create_duckdb_server()

    logger.info("Using model: %s", ANTHROPIC_MODEL)

    # Use the --resume flag to continue an existing session
    options = ClaudeAgentOptions(
        model=ANTHROPIC_MODEL,
        system_prompt=build_system_prompt(),
        mcp_servers={"duckdb": duckdb_server},
        allowed_tools=["mcp__duckdb__execute_sql"],
        permission_mode="bypassPermissions",
        max_turns=20,
        include_partial_messages=True,
        **({"resume": session_id} if session_id else {}),
    )

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
            observation_ctx = langfuse.start_as_current_observation(
                name="agent-chat",
                input={"message": message[:500]},
                metadata={"model": ANTHROPIC_MODEL},
            )
            observation_ctx.__enter__()

            # If resuming, propagate the known session_id for child spans
            if session_id:
                from langfuse import propagate_attributes
                propagate_ctx = propagate_attributes(session_id=session_id)
                propagate_ctx.__enter__()
        except Exception as e:
            logger.debug("Failed to set up Langfuse tracing context: %s", e)
            observation_ctx = None

    try:
        await client.connect()
        await client.query(message, session_id=session_id or "default")

        current_text = ""
        has_tool_calls = False
        thinking_sent = False
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
                            current_text += text
                            yield f"event: thinking\ndata: {json.dumps({'text': text})}\n\n"
                    elif delta_type == "text_delta":
                        text = delta.get("text", "")
                        current_text += text
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
                        if current_text.strip() and not thinking_sent:
                            thinking_sent = True
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
        yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"
    finally:
        # Update trace with the CLI's session_id so Langfuse session matches
        if langfuse and observation_ctx:
            try:
                langfuse.update_current_trace(
                    session_id=actual_session_id,
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
