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
from claude_agent_sdk._errors import MessageParseError
from claude_agent_sdk._internal.message_parser import parse_message
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


def _truncate(text: str, max_len: int = 1000) -> str:
    """Truncate text for trace data, appending '...' if trimmed."""
    if len(text) <= max_len:
        return text
    return text[:max_len] + "..."


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
    options = ClaudeAgentOptions(
        model=ANTHROPIC_MODEL,
        system_prompt=build_system_prompt(),
        mcp_servers={"duckdb": duckdb_server},
        allowed_tools=["mcp__duckdb__execute_sql"],
        permission_mode="bypassPermissions",
        max_turns=20,
        include_partial_messages=True,
    )

    client = ClaudeSDKClient(options=options)
    actual_session_id = session_id

    # --- Langfuse tracing setup (conditional) ---
    langfuse = get_langfuse_client()
    trace = None
    if langfuse:
        try:
            trace = langfuse.start_span(name="agent-chat")
            trace.update_trace(
                session_id=session_id or "default",
                input={"message": _truncate(message, 500)},
                metadata={"model": ANTHROPIC_MODEL},
            )
        except Exception as e:
            logger.debug("Failed to create Langfuse trace: %s", e)
            trace = None

    # Tracing state
    current_generation = None
    turn_number = 0
    accumulated_thinking = ""
    accumulated_answer = ""

    def _end_generation():
        """End the current generation span, recording accumulated text."""
        nonlocal current_generation, accumulated_thinking, accumulated_answer
        if current_generation:
            try:
                output_data = {}
                if accumulated_thinking:
                    output_data["thinking"] = _truncate(accumulated_thinking)
                if accumulated_answer:
                    output_data["text"] = _truncate(accumulated_answer)
                current_generation.update(output=output_data)
                current_generation.end()
            except Exception as e:
                logger.debug("Failed to end Langfuse generation: %s", e)
            current_generation = None
        accumulated_thinking = ""
        accumulated_answer = ""

    def _start_generation():
        """Start a new generation span for an LLM turn."""
        nonlocal current_generation, turn_number
        if not trace:
            return
        _end_generation()
        turn_number += 1
        try:
            input_data = (
                {"message": _truncate(message, 500)}
                if turn_number == 1
                else {"continued": True}
            )
            current_generation = trace.start_generation(
                name=f"llm-turn-{turn_number}",
                model=ANTHROPIC_MODEL,
                input=input_data,
            )
        except Exception as e:
            logger.debug("Failed to create Langfuse generation: %s", e)
            current_generation = None

    try:
        await client.connect()
        await client.query(message, session_id=session_id or "default")

        current_text = ""
        has_tool_calls = False
        thinking_sent = False
        has_thinking = False
        sql_result_ids: set[str] = set()
        tool_names: dict[str, str] = {}

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
                    if delta_type == "thinking_delta":
                        text = delta.get("thinking", "")
                        if text:
                            current_text += text
                            accumulated_thinking += text
                            yield f"event: thinking\ndata: {json.dumps({'text': text})}\n\n"
                    elif delta_type == "text_delta":
                        text = delta.get("text", "")
                        current_text += text
                        accumulated_answer += text
                        event_name = "thinking" if not has_tool_calls else "answer"
                        yield f"event: {event_name}\ndata: {json.dumps({'text': text})}\n\n"

                elif event_type == "content_block_start":
                    block = event.get("content_block", {})
                    block_type = block.get("type")
                    if block_type == "thinking":
                        has_thinking = True
                        # Start a new generation span for this LLM turn
                        if trace:
                            _start_generation()
                    elif block_type == "text":
                        if has_thinking:
                            yield f"event: thinking_done\ndata: {json.dumps({})}\n\n"
                        # If no thinking block preceded, start generation now
                        if not has_thinking and trace:
                            _start_generation()
                    elif block_type == "tool_use":
                        # End the current generation before tool use
                        if trace:
                            _end_generation()
                        if current_text.strip() and not thinking_sent:
                            thinking_sent = True
                        has_tool_calls = True

            elif isinstance(msg, AssistantMessage):
                if not actual_session_id:
                    actual_session_id = "default"

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

                            # Create a tool span for the SQL execution
                            tool_span = None
                            if trace:
                                try:
                                    tool_span = trace.start_span(
                                        name=f"tool-{tool_name}",
                                        input={"sql": sql},
                                    )
                                except Exception as e:
                                    logger.debug("Failed to create Langfuse tool span: %s", e)

                            try:
                                result = db.execute_query(sql)
                                truncated = result["rows"][:100]
                                yield f"event: tool_result\ndata: {json.dumps({'id': block.id, 'name': tool_name, 'sql': sql, 'columns': result['columns'], 'rows': truncated, 'rowCount': result['rowCount']}, default=str)}\n\n"

                                # End tool span with success
                                if tool_span:
                                    try:
                                        tool_span.update(output={
                                            "rowCount": result["rowCount"],
                                            "columns": result["columns"],
                                        })
                                        tool_span.end()
                                    except Exception as e:
                                        logger.debug("Failed to end Langfuse tool span: %s", e)

                            except Exception as e:
                                yield f"event: tool_result\ndata: {json.dumps({'id': block.id, 'name': tool_name, 'sql': sql, 'error': str(e)})}\n\n"

                                # End tool span with error
                                if tool_span:
                                    try:
                                        tool_span.update(
                                            output={"error": str(e)},
                                            level="ERROR",
                                        )
                                        tool_span.end()
                                    except Exception as ex:
                                        logger.debug("Failed to end Langfuse tool span: %s", ex)

            elif isinstance(msg, UserMessage):
                # Capture tool results from the SDK for non-SQL tools
                # Note: only SQL tool executions produce Langfuse spans (see above)
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
                actual_session_id = msg.session_id
                if msg.is_error and msg.result:
                    yield f"event: error\ndata: {json.dumps({'message': msg.result})}\n\n"
                yield f"event: done\ndata: {json.dumps({'session_id': actual_session_id})}\n\n"
                break

    except Exception as e:
        yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"
    finally:
        # End any open generation span
        if trace:
            _end_generation()

        # Update trace output and flush
        if trace:
            try:
                trace.update_trace(
                    output={"session_id": actual_session_id},
                )
                trace.end()
            except Exception as e:
                logger.debug("Failed to update Langfuse trace: %s", e)

        if langfuse:
            try:
                langfuse.flush()
            except Exception as e:
                logger.debug("Failed to flush Langfuse: %s", e)

        try:
            await client.disconnect()
        except Exception:
            pass
