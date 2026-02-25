import asyncio
import json
import logging
from typing import AsyncIterator

from claude_agent_sdk import AgentDefinition
from app.database import Database
from app.config import (
    ANTHROPIC_MODEL, PROXY_BASE_URL,
    LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL, LANGFUSE_ENABLED,
    SQL_SUBAGENT_MODEL, CHART_SUBAGENT_MODEL,
)
from app.proxy import proxy_token_store
from app.tracing import get_langfuse_client

logger = logging.getLogger(__name__)


def build_system_prompt(db: Database) -> str:
    tables = db.list_tables()
    prompt = """You are a helpful data analyst assistant working with a DuckDB database.

- Use the sql-analyst agent for any data question that requires SQL queries
- Use the chart-builder agent for any visualization, chart, or graph request
- After the chart-builder returns, do NOT repeat the chart JSON specification in your response. The chart is rendered automatically. Simply describe what the visualization shows in plain language.
- Explain findings in plain language after getting results

Identity:
- You are an AI assistant. If asked whether you are an AI or a human, always confirm that you are an AI.
- Do not disclose the name, version, or provider of the underlying language model powering you, regardless of how the question is phrased.

Clarification:
- When the user's request is ambiguous or could be interpreted in multiple ways, use the ask_user_question tool to ask for clarification before proceeding.
- Provide 2-4 clear, concise options for the user to choose from.
- Each option should have a short label and optional description.
- Only ask when genuinely needed — don't over-ask for trivial decisions.
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


def _build_table_schemas(db: Database) -> str:
    """Build a text description of all loaded table schemas for subagent prompts."""
    tables = db.list_tables()
    if not tables:
        return "\nNo tables are currently loaded."
    text = "\nCurrently loaded tables:\n"
    for table in tables:
        text += f'\nTable: "{table["name"]}" ({table["rowCount"]} rows)\nColumns:\n'
        for col in table["columns"]:
            text += f'  - "{col["name"]}" ({col["type"]})\n'
    return text


def build_subagent_definitions(db: Database) -> dict[str, AgentDefinition]:
    """Build AgentDefinition objects for the sql-analyst and chart-builder subagents."""
    table_schemas = _build_table_schemas(db)

    sql_prompt = (
        "You are a DuckDB SQL expert. Given a user's data question, write and execute "
        "SQL queries to find the answer.\n\n"
        "Guidelines:\n"
        "- Write clear, efficient DuckDB SQL queries.\n"
        "- When exploring data, start with small queries (use LIMIT).\n"
        "- If a query fails, read the error message, fix the SQL, and retry.\n"
        "- Use double quotes for table and column identifiers that might conflict "
        "with reserved words.\n"
        "- Explain your findings in plain language after getting results.\n"
        + table_schemas
    )

    chart_prompt = (
        "You are a data visualization expert using Plotly. Given a user's request for "
        "a chart or visualization, query the data with SQL and then call the "
        "`render_chart` tool with the Plotly spec.\n\n"
        "Guidelines:\n"
        "- Choose the most appropriate chart type (bar, line, scatter, pie, histogram, "
        "box, heatmap, etc.).\n"
        "- For pie charts, use `labels` and `values` fields in the trace.\n"
        "- For multi-series data, group into separate traces.\n"
        "- `layout.title` is required — always provide a descriptive title.\n"
        "- Keep the chart clean and readable.\n\n"
        "IMPORTANT — keep data small. Pre-aggregate in SQL instead of passing raw rows:\n"
        "- Box plots: compute lowerfence, q1, median, q3, upperfence per group in SQL. "
        "Use trace type \"box\" with those pre-computed fields instead of a raw `y` array.\n"
        "- Histograms: compute bin counts with width_bucket() or CASE in SQL, then "
        "render as a bar chart with the bin edges as `x` and counts as `y`.\n"
        "- Scatter / line with many rows: sample (ORDER BY random() LIMIT 200) or "
        "aggregate (e.g. average per time bucket) so each trace has at most ~200 points.\n"
        "- General rule: each trace should have at most ~200 data points. "
        "Large tool-call inputs cause malformed JSON and validation errors.\n\n"
        "When ready to render, call `render_chart` with:\n"
        "- `data`: array of Plotly trace objects\n"
        "- `layout`: object containing at minimum {\"title\": \"<descriptive title>\"}\n\n"
        "Do NOT output a JSON code block. Use the tool.\n"
        + table_schemas
    )

    return {
        "sql-analyst": AgentDefinition(
            description=(
                "Use this agent for any data question that requires SQL queries "
                "— exploring data, aggregations, filtering, joins, etc."
            ),
            prompt=sql_prompt,
            tools=["mcp__duckdb__execute_sql"],
            model=SQL_SUBAGENT_MODEL,
        ),
        "chart-builder": AgentDefinition(
            description=(
                "Use this agent when the user wants a chart, graph, or visualization."
            ),
            prompt=chart_prompt,
            tools=["mcp__duckdb__execute_sql", "mcp__duckdb__render_chart"],
            model=CHART_SUBAGENT_MODEL,
        ),
    }


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



def _build_chart_spec_from_stream_messages(
    msg: dict, tool_names: dict[str, str], subagent_chart_specs: dict
) -> None:
    """Inspect an assistant message and capture render_chart input as chart_spec.

    When the chart-builder subagent calls render_chart, the tool_use block
    appears in an assistant message whose parent_tool_use_id is the Task
    tool_use_id for the chart-builder.  We extract input directly so we never
    need to parse free-text JSON.
    """
    parent_id = msg.get("parent_tool_use_id")
    if not parent_id or tool_names.get(parent_id) != "chart-builder":
        return
    for block in msg.get("message", {}).get("content", []):
        if block.get("type") == "tool_use" and "render_chart" in block.get("name", ""):
            subagent_chart_specs[parent_id] = block.get("input", {})
            return


async def stream_chat(
    message: str,
    session_id: str | None = None,
    db: Database | None = None,
    conversation_history: list[dict] | None = None,
    langfuse_session_id: str | None = None,
    backend_session_id: str | None = None,
) -> AsyncIterator[str]:
    """Stream agent chat responses as SSE events via containerized sidecar."""
    from app.container_manager import container_manager
    if container_manager is None:
        raise RuntimeError("Docker is not available. Container mode requires Docker.")
    if db is None:
        raise ValueError("db must be provided")

    import httpx
    import asyncio

    query_message = _build_message_with_history(message, conversation_history)
    system_prompt = build_system_prompt(db)

    session_token = proxy_token_store.create_token()

    # Pass Langfuse credentials to the container so the sidecar's
    # TypeScript Langfuse SDK can create traces directly.
    env: dict[str, str] = {
        "ANTHROPIC_API_KEY": session_token,
        "ANTHROPIC_BASE_URL": f"{PROXY_BASE_URL}/anthropic",
    }
    if LANGFUSE_ENABLED:
        env["LANGFUSE_PUBLIC_KEY"] = LANGFUSE_PUBLIC_KEY
        env["LANGFUSE_SECRET_KEY"] = LANGFUSE_SECRET_KEY
        env["LANGFUSE_BASE_URL"] = LANGFUSE_BASE_URL

    if "127.0.0.1" in PROXY_BASE_URL or "localhost" in PROXY_BASE_URL:
        logger.warning(
            "PROXY_BASE_URL=%s uses localhost which is unreachable from containers. "
            "Set PROXY_BASE_URL to the host's Docker-accessible address "
            "(e.g., http://host.docker.internal:10000).",
            PROXY_BASE_URL,
        )

    # Use the backend session ID (X-Session-ID header) for both:
    # 1. MCP SSE URL — so the container queries the correct DuckDB instance
    # 2. Container lifecycle key — so the same container is reused across
    #    requests from the same browser tab (the Claude agent session_id
    #    changes after the first response, which would orphan the container)
    stable_session = backend_session_id or session_id or "default"

    try:
        # Send SSE keepalive immediately so the HTTP response starts and
        # intermediate proxies (Vite, nginx) don't drop the idle connection
        # before we've finished the blocking Docker container creation.
        yield ": keepalive\n\n"

        # container_manager.create() is synchronous (blocking Docker API call).
        # Run it in a thread executor so the event loop stays responsive and
        # can continue flushing keepalives to the client during startup.
        # gVisor (runsc) containers can take 10-30 seconds to spin up.
        loop = asyncio.get_event_loop()
        create_future = loop.run_in_executor(None, container_manager.create, stable_session, env)

        max_create_wait = 60.0
        elapsed = 0.0
        while not create_future.done():
            await asyncio.sleep(2.0)
            elapsed += 2.0
            if elapsed >= max_create_wait:
                create_future.cancel()
                raise RuntimeError(f"Container creation timed out after {max_create_wait:.0f}s")
            yield ": keepalive\n\n"
        info = await create_future

        # Wait for container to be ready
        for attempt in range(10):
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as check_client:
                    resp = await check_client.get(f"{info.url}/health")
                    if resp.status_code == 200:
                        break
            except Exception:
                pass
            yield ": keepalive\n\n"
            await asyncio.sleep(1)
        else:
            raise RuntimeError("Sidecar container failed health check after 10 attempts")

        payload: dict = {
            "message": query_message,
            "session_id": session_id,
            "system_prompt": system_prompt,
            "model": ANTHROPIC_MODEL,
            "mcp_server_url": f"{PROXY_BASE_URL}/mcp/sse?session_id={stable_session}",
            "env": {
                "ANTHROPIC_API_KEY": session_token,
                "ANTHROPIC_BASE_URL": f"{PROXY_BASE_URL}/anthropic",
            },
            "agents": {
                name: {
                    "description": agent_def.description,
                    "prompt": agent_def.prompt,
                    "tools": agent_def.tools,
                    "model": agent_def.model,
                }
                for name, agent_def in build_subagent_definitions(db).items()
            },
        }
        if langfuse_session_id:
            payload["langfuse_session_id"] = langfuse_session_id
        # Pass original message & history separately for Langfuse trace metadata
        if conversation_history:
            payload["original_message"] = message
            payload["conversation_history"] = conversation_history

        has_tool_calls = False
        has_thinking = False
        done_sent = False
        waiting_for_user = False
        tool_names: dict[str, str] = {}
        tool_sqls: dict[str, str] = {}
        # Track subagent text output from intermediate assistant messages.
        # The TypeScript SDK's Task tool_result contains only metadata (agentId,
        # usage), not the subagent's actual output.  The real output arrives in
        # assistant messages whose parent_tool_use_id matches the Task tool ID.
        subagent_texts: dict[str, str] = {}
        subagent_chart_specs: dict[str, dict] = {}
        actual_session_id = session_id

        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as client:
            async with client.stream("POST", f"{info.url}/query", json=payload) as response:
                line_iter = response.aiter_lines().__aiter__()
                while True:
                    try:
                        if waiting_for_user:
                            try:
                                line = await asyncio.wait_for(line_iter.__anext__(), timeout=5.0)
                            except asyncio.TimeoutError:
                                yield ": keepalive\n\n"
                                continue
                        else:
                            line = await line_iter.__anext__()
                    except StopAsyncIteration:
                        break

                    if not line.startswith("data: "):
                        continue
                    raw = line[6:]
                    waiting_for_user = False
                    try:
                        msg = json.loads(raw)
                    except json.JSONDecodeError:
                        continue

                    msg_type = msg.get("type")
                    # --- Token-level streaming events from SDK ---
                    if msg_type == "stream_event":
                        event = msg.get("event", {})
                        event_type = event.get("type", "")
                        stream_parent = msg.get("parent_tool_use_id")
                        is_subagent_event = bool(stream_parent and stream_parent in tool_names)

                        if event_type == "content_block_delta":
                            delta = event.get("delta", {})
                            delta_type = delta.get("type", "")
                            if delta_type == "thinking_delta":
                                text = delta.get("thinking", "")
                                if text and not is_subagent_event:
                                    yield f"event: thinking\ndata: {json.dumps({'text': text})}\n\n"
                            elif delta_type == "text_delta":
                                text = delta.get("text", "")
                                if text:
                                    # Accumulate subagent text for chart_spec
                                    # extraction (the SDK may not yield a
                                    # complete assistant message for the
                                    # subagent's final turn).
                                    if is_subagent_event:
                                        subagent_texts[stream_parent] = subagent_texts.get(stream_parent, "") + text
                                        yield f"event: subagent_text\ndata: {json.dumps({'id': stream_parent, 'name': tool_names.get(stream_parent, ''), 'text': text})}\n\n"
                                    else:
                                        event_name = "answer" if has_tool_calls else "thinking"
                                        yield f"event: {event_name}\ndata: {json.dumps({'text': text})}\n\n"

                        elif event_type == "content_block_start":
                            block = event.get("content_block", {})
                            block_type = block.get("type")
                            if block_type == "thinking":
                                if not is_subagent_event:
                                    has_thinking = True
                            elif block_type == "text":
                                if has_thinking and not is_subagent_event:
                                    yield f"event: thinking_done\ndata: {json.dumps({})}\n\n"
                            elif block_type == "tool_use":
                                if not is_subagent_event:
                                    has_thinking = False
                                    has_tool_calls = True

                    # --- Complete assistant message (contains tool_use blocks) ---
                    elif msg_type == "assistant":
                        message_obj = msg.get("message", {})
                        parent_tool_use_id = msg.get("parent_tool_use_id")

                        # Capture text from subagent assistant messages.
                        # These carry the real subagent output (e.g. chart JSON)
                        # that the Task tool_result metadata lacks.
                        if parent_tool_use_id and parent_tool_use_id in tool_names:
                            text_parts = []
                            for block in message_obj.get("content", []):
                                if block.get("type") == "text" and block.get("text"):
                                    text_parts.append(block["text"])
                            if text_parts:
                                subagent_texts[parent_tool_use_id] = "\n".join(text_parts)
                        _build_chart_spec_from_stream_messages(msg, tool_names, subagent_chart_specs)

                        for block in message_obj.get("content", []):
                            block_type = block.get("type")
                            if block_type == "tool_use":
                                has_tool_calls = True
                                tool_id = block.get("id", "")
                                tool_name = block.get("name", "")
                                tool_input = block.get("input", {})
                                tool_names[tool_id] = tool_name
                                is_execute_sql = "execute_sql" in tool_name
                                sql = tool_input.get("sql", "") if is_execute_sql else ""
                                if sql:
                                    tool_sqls[tool_id] = sql
                                tool_call_data: dict = {"id": tool_id, "name": tool_name}
                                if sql:
                                    tool_call_data["sql"] = sql
                                else:
                                    tool_call_data["input"] = tool_input
                                yield f"event: tool_call\ndata: {json.dumps(tool_call_data, default=str)}\n\n"
                                if tool_name == "Task":
                                    subagent_name = tool_input.get("subagent_type", "unknown")
                                    subagent_prompt = tool_input.get("prompt", "")
                                    tool_names[tool_id] = subagent_name
                                    yield f"event: subagent_start\ndata: {json.dumps({'id': tool_id, 'name': subagent_name, 'prompt': subagent_prompt})}\n\n"

                                # Detect ask_user_question tool
                                if "ask_user_question" in tool_name:
                                    from app.pending_questions import pending_question_store
                                    import asyncio as _asyncio
                                    for _ in range(50):
                                        pending = pending_question_store.get_pending(stable_session)
                                        if pending:
                                            yield f"event: user_question\ndata: {json.dumps({'question_id': pending['question_id'], **pending['data']})}\n\n"
                                            waiting_for_user = True
                                            break
                                        await _asyncio.sleep(0.1)

                    # --- Tool results from user messages ---
                    elif msg_type == "user":
                        message_obj = msg.get("message", {})
                        # The SDK attaches the subagent's actual output in
                        # tool_use_result.content (a list of content blocks).
                        # Extract it so we can use it for chart_spec extraction.
                        tool_use_result = msg.get("tool_use_result")
                        tool_use_result_text = ""
                        if isinstance(tool_use_result, dict):
                            tur_content = tool_use_result.get("content")
                            if isinstance(tur_content, list):
                                parts = []
                                for item in tur_content:
                                    if isinstance(item, dict) and item.get("type") == "text":
                                        parts.append(item.get("text", ""))
                                tool_use_result_text = "\n".join(parts)
                        for block in message_obj.get("content", []):
                            if block.get("type") != "tool_result":
                                continue
                            tool_id = block.get("tool_use_id", "")
                            name = tool_names.get(tool_id, "")
                            content_parts = block.get("content", [])
                            text = ""
                            if isinstance(content_parts, list):
                                for part in content_parts:
                                    if isinstance(part, dict) and part.get("type") == "text":
                                        text = part.get("text", "")
                            elif isinstance(content_parts, str):
                                text = content_parts

                            # Try to parse structured MCP result
                            result_data: dict = {"id": tool_id, "name": name}
                            # Include the SQL from the original tool_call
                            original_sql = tool_sqls.get(tool_id, "")
                            if original_sql:
                                result_data["sql"] = original_sql
                            try:
                                parsed = json.loads(text)
                                if parsed.get("status") == "success":
                                    if "chart_spec" in parsed:
                                        result_data["chart_spec"] = parsed["chart_spec"]
                                    else:
                                        result_data["columns"] = parsed.get("columns", [])
                                        result_data["rows"] = parsed.get("rows", [])[:100]
                                        result_data["rowCount"] = parsed.get("rowCount", 0)
                                elif parsed.get("status") == "error":
                                    result_data["error"] = parsed.get("error", "")
                                else:
                                    result_data["output"] = text
                            except (json.JSONDecodeError, AttributeError):
                                result_data["output"] = text
                            if block.get("is_error"):
                                try:
                                    parsed_err = json.loads(text)
                                    result_data["error"] = parsed_err.get("error", text)
                                except (json.JSONDecodeError, AttributeError):
                                    result_data["error"] = text
                            # Detect subagent result (Task tool)
                            if name in ("sql-analyst", "chart-builder"):
                                # Only chart-builder produces chart_spec JSON.
                                # sql-analyst returns plain text results.
                                if name == "chart-builder":
                                    chart_spec = subagent_chart_specs.get(tool_id)
                                    end_data: dict = {"id": tool_id, "name": name}
                                    if chart_spec:
                                        end_data["chart_spec"] = chart_spec
                                    else:
                                        end_data["result"] = tool_use_result_text or subagent_texts.get(tool_id, text)
                                        logger.warning(
                                            "[container] render_chart tool_use not found for chart-builder %s",
                                            tool_id,
                                        )
                                    yield f"event: subagent_end\ndata: {json.dumps(end_data, default=str)}\n\n"
                                    continue
                                else:
                                    end_data: dict = {"id": tool_id, "name": name}
                                    end_data["result"] = tool_use_result_text or subagent_texts.get(tool_id, text)
                                    yield f"event: subagent_end\ndata: {json.dumps(end_data, default=str)}\n\n"
                                    continue
                            yield f"event: tool_result\ndata: {json.dumps(result_data, default=str)}\n\n"

                    # --- Final result ---
                    elif msg_type == "result":
                        actual_session_id = msg.get("session_id") or actual_session_id
                        if msg.get("is_error"):
                            errors = msg.get("errors", [])
                            error_text = msg.get("result") or "; ".join(errors) or "Unknown error"
                            yield f"event: error\ndata: {json.dumps({'message': error_text})}\n\n"
                        yield f"event: done\ndata: {json.dumps({'session_id': actual_session_id})}\n\n"
                        done_sent = True

                    # --- Sidecar error (e.g. SDK/CLI crash inside container) ---
                    elif msg_type == "error":
                        error_text = msg.get("message") or "Sidecar error"
                        logger.error("Sidecar reported error: %s", error_text)
                        yield f"event: error\ndata: {json.dumps({'message': error_text})}\n\n"

                    # --- Extract session_id early from system init ---
                    elif msg_type == "system":
                        sys_session = msg.get("session_id")
                        if sys_session:
                            actual_session_id = sys_session

        # Guard: always send done even if sidecar ended without result message
        if not done_sent:
            logger.warning("Sidecar stream ended without result message; sending done event")
            yield f"event: done\ndata: {json.dumps({'session_id': actual_session_id})}\n\n"

    except Exception as e:
        logger.error("Container agent error: %s", str(e))
        yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"
    finally:
        proxy_token_store.revoke_token(session_token)
        # Container intentionally kept alive for session resume (--resume flag).
        # Containers are cleaned up by the background cleanup loop after
        # CONTAINER_MAX_LIFETIME_SECONDS, or on application shutdown.
