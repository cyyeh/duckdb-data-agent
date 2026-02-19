import json
import logging
from typing import AsyncIterator

from claude_agent_sdk import (
    ClaudeSDKClient,
    ClaudeAgentOptions,
    AssistantMessage,
    ResultMessage,
    ToolUseBlock,
)
from claude_agent_sdk._errors import MessageParseError
from claude_agent_sdk._internal.message_parser import parse_message
from claude_agent_sdk.types import StreamEvent
from app.tools import create_duckdb_server
from app.database import db

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


async def stream_chat(message: str, session_id: str | None = None) -> AsyncIterator[str]:
    """Stream agent chat responses as SSE events."""
    duckdb_server = create_duckdb_server()

    options = ClaudeAgentOptions(
        system_prompt=build_system_prompt(),
        mcp_servers={"duckdb": duckdb_server},
        allowed_tools=["mcp__duckdb__execute_sql"],
        permission_mode="bypassPermissions",
        max_turns=20,
        include_partial_messages=True,
    )

    client = ClaudeSDKClient(options=options)
    actual_session_id = session_id

    try:
        await client.connect()
        await client.query(message, session_id=session_id or "default")

        current_text = ""
        has_tool_calls = False
        thinking_sent = False

        async for raw_data in client._query.receive_messages():
            try:
                msg = parse_message(raw_data)
            except MessageParseError as e:
                logger.debug("Skipping unrecognized message: %s", e)
                continue

            if isinstance(msg, StreamEvent):
                event = msg.event
                if not actual_session_id:
                    actual_session_id = msg.session_id

                event_type = event.get("type", "")

                if event_type == "content_block_delta":
                    delta = event.get("delta", {})
                    delta_type = delta.get("type", "")
                    if delta_type == "text_delta":
                        text = delta.get("text", "")
                        current_text += text
                        event_name = "thinking" if not has_tool_calls else "answer"
                        yield f"event: {event_name}\ndata: {json.dumps({'text': text})}\n\n"

                elif event_type == "content_block_start":
                    block = event.get("content_block", {})
                    if block.get("type") == "tool_use":
                        if current_text.strip() and not thinking_sent:
                            thinking_sent = True
                        has_tool_calls = True

            elif isinstance(msg, AssistantMessage):
                if not actual_session_id:
                    actual_session_id = "default"

                for block in msg.content:
                    if isinstance(block, ToolUseBlock):
                        sql = block.input.get("sql", "")
                        yield f"event: tool_call\ndata: {json.dumps({'id': block.id, 'sql': sql})}\n\n"
                        has_tool_calls = True

                        # Execute the query directly for the UI since
                        # ToolResultBlock is not exposed in the SDK stream
                        try:
                            result = db.execute_query(sql)
                            truncated = result["rows"][:100]
                            yield f"event: tool_result\ndata: {json.dumps({'id': block.id, 'sql': sql, 'columns': result['columns'], 'rows': truncated, 'rowCount': result['rowCount']}, default=str)}\n\n"
                        except Exception as e:
                            yield f"event: tool_result\ndata: {json.dumps({'id': block.id, 'sql': sql, 'error': str(e)})}\n\n"

            elif isinstance(msg, ResultMessage):
                actual_session_id = msg.session_id
                if msg.is_error and msg.result:
                    yield f"event: error\ndata: {json.dumps({'message': msg.result})}\n\n"
                yield f"event: done\ndata: {json.dumps({'session_id': actual_session_id})}\n\n"
                break

    except Exception as e:
        yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"
    finally:
        try:
            await client.disconnect()
        except Exception:
            pass
