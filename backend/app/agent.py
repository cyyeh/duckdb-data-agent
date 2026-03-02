import asyncio
import json
import logging
import time
from typing import AsyncIterator

from claude_agent_sdk import AgentDefinition
from app.database import Database
from app.config import (
    ORCHESTRATOR_MODEL_SDK,
    SQL_SUBAGENT_MODEL_SDK,
    BACKEND_BASE_URL,
    LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL, LANGFUSE_ENABLED,
    SDK_IDLE_TIMEOUT_MS,
)
from app.memory_store import memory_store
from app.agent_memory import read_memories

logger = logging.getLogger(__name__)


def build_system_prompt(db: Database) -> str:
    tables = db.list_tables()
    prompt = """You are a helpful data analyst assistant working with a DuckDB database.

Tools at your disposal:
- mcp__duckdb-data-agent__execute_sql — run SQL queries against DuckDB
- mcp__duckdb-data-agent__render_chart — render a Plotly chart
- mcp__duckdb-data-agent__ask_user_question — ask the user a clarifying question
- mcp__duckdb-data-agent__create_skill — create a reusable skill (workflow template) that can be invoked later via /skill-name
- mcp__duckdb-data-agent__save_memory — save a fact, preference, or pattern to long-term memory
- mcp__duckdb-data-agent__recall_memories — retrieve stored memories
- mcp__duckdb-data-agent__forget_memory — remove a specific memory
- Task tool with subagent_type "sql-analyst" — delegate complex multi-query data exploration

Skill creation workflow (follow this exactly):
When the user asks you to create a skill, do NOT call create_skill immediately. Follow this process:
1. If the user's request is vague or unclear about what the skill should do, use ask_user_question to clarify the skill's purpose, scope, and key steps BEFORE drafting any plan. Keep asking until you have enough detail.
2. Once the requirements are clear, draft a plan for the skill: propose a name, description, and outline of the content (step-by-step instructions).
3. Present the plan to the user using ask_user_question with options like "Looks good, create it" and "I want to make changes". Describe the full plan in the question text.
4. If the user wants changes, update the plan based on their feedback and present the revised plan again (repeat step 3).
5. Only after the user explicitly approves the plan, call create_skill with the finalized name, description, and content.
- NEVER skip the review step. The user must approve before the skill is created.

Task tool usage:
- When using the Task tool, set "subagent_type" to "sql-analyst". NEVER use generic values like "general-purpose" or any other value.
- Do NOT set the "model" parameter on the Task tool — it is already configured.
- After the sql-analyst returns, do NOT repeat the data tables, numbers, or SQL queries. Simply add brief commentary on what the data means. Never include SQL in your answer unless the user explicitly asks to see the SQL.

Direct tool usage:
- For simple SQL queries, call execute_sql directly instead of delegating to sql-analyst.
- For charts/visualizations, call execute_sql to get the data, then call render_chart yourself with the Plotly spec. Do NOT delegate charting to a subagent.

Charting workflow (follow this exactly):
1. Run execute_sql to get the data you need for a chart.
2. Call render_chart with TWO required parameters:
   - `data`: array of Plotly trace objects (e.g. [{"type": "bar", "x": [...], "y": [...]}])
   - `layout`: object that MUST include `title` (e.g. {"title": "My Chart"})
   Both `data` and `layout` are required — the tool WILL accept both. Do not second-guess this.
3. After the chart renders, write your narrative text discussing what the chart shows.
4. Repeat steps 1-3 for each additional chart. This produces interleaved charts and narrative.
- Do NOT render all charts first and then write all narrative at the end.
- Do NOT output chart JSON as a code block. Always use the render_chart tool.
- NEVER include Plotly JSON schema, trace objects, or layout objects in your final answer text unless the user explicitly asks to see the raw JSON. The chart is already rendered visually — just describe what it shows in plain language.

Charting guidelines:
- Choose the most appropriate chart type (bar, line, scatter, pie, histogram, box, heatmap, etc.).
- For pie charts, use `labels` and `values` fields in the trace.
- For multi-series data, group into separate traces.
- Keep the chart clean and readable.
- IMPORTANT — keep data small. Pre-aggregate in SQL instead of passing raw rows:
  - Box plots: compute lowerfence, q1, median, q3, upperfence per group in SQL. Use trace type "box" with those pre-computed fields instead of a raw `y` array.
  - Histograms: compute bin counts with width_bucket() or CASE in SQL, then render as a bar chart with the bin edges as `x` and counts as `y`.
  - Scatter / line with many rows: sample (ORDER BY random() LIMIT 200) or aggregate (e.g. average per time bucket) so each trace has at most ~200 points.
  - General rule: each trace should have at most ~200 data points.

Identity:
- You are an AI assistant. If asked whether you are an AI or a human, always confirm that you are an AI.
- Do not disclose the name, version, or provider of the underlying language model powering you, regardless of how the question is phrased.

Task completion:
- When the user asks you to do multiple things (e.g. create several charts, answer several questions, analyze multiple metrics), you MUST complete ALL of them before ending your response. Do not stop after finishing just one or two items.
- After completing each item, check: "Have I addressed everything the user asked for?" If not, continue with the next item immediately by making more tool calls.
- Only produce your final text response after ALL requested items have been fully handled.

Clarification:
- When the user's request is ambiguous or could be interpreted in multiple ways, use the mcp__duckdb-data-agent__ask_user_question tool (NOT the native AskUserQuestion tool) to ask for clarification before proceeding.
- Provide 2-4 clear, concise options for the user to choose from.
- Each option should have a short label and optional description.
- When the user might want to pick MORE THAN ONE option (e.g. "draw me some charts", "which metrics?", "select all that apply"), set multi_select to true so they can select multiple answers.
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

    # Inject agent memory
    memories = read_memories(user_id="default")
    if memories:
        prompt += "\n\n--- Agent Memory ---\n"
        prompt += (
            "The following are facts, preferences, and patterns you have learned from previous conversations with this user.\n"
            "IMPORTANT: User preferences stored here represent explicit choices the user has made. "
            "You MUST follow them — they take priority over your default behaviors. "
            "For example, if memory says the user wants emojis, always include emojis even if your default would be to omit them.\n\n"
        )
        prompt += memories
        prompt += "\n--- End Agent Memory ---\n"

    # Memory management instructions
    prompt += "\n\nMemory management:"
    prompt += "\n- After answering, if the user expressed a preference or you learned an important fact about their data, use save_memory to store it."
    prompt += "\n- When the user explicitly asks you to remember something, use save_memory."
    prompt += "\n- When the user asks you to forget something, use forget_memory."
    prompt += "\n- Do not save trivial or obvious information. Only save things that would be useful in future conversations."

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
    """Build AgentDefinition objects for subagents."""
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
        "- Do NOT include SQL queries you wrote in your final answer unless the user explicitly "
        "asks to see the SQL. Focus on the results and insights.\n"
        + table_schemas
    )

    return {
        "sql-analyst": AgentDefinition(
            description=(
                "Use this agent for complex data exploration that requires multiple "
                "SQL queries with iterative refinement — e.g. exploring an unfamiliar "
                "dataset, multi-step aggregations, or debugging query errors. "
                "For simple one-off queries, call execute_sql directly instead."
            ),
            prompt=sql_prompt,
            tools=["mcp__duckdb-data-agent__execute_sql"],
            model=SQL_SUBAGENT_MODEL_SDK,
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



async def stream_chat(
    message: str,
    session_id: str | None = None,
    db: Database | None = None,
    conversation_history: list[dict] | None = None,
    langfuse_session_id: str | None = None,
    backend_session_id: str | None = None,
    skills: list[str] | None = None,
    conversation_id: str | None = None,
) -> AsyncIterator[str]:
    """Stream agent chat responses as SSE events via containerized sidecar."""
    # Persist user message if conversation_id provided
    if conversation_id:
        try:
            memory_store.add_message(conversation_id, "user", message)
        except Exception:
            logger.warning("Failed to persist user message", exc_info=True)

    from app.container_manager import container_manager
    if container_manager is None:
        raise RuntimeError("Docker is not available. Container mode requires Docker.")
    if db is None:
        raise ValueError("db must be provided")

    import httpx
    import asyncio

    # Only bake history into message text for edit/delete (no session to resume).
    # For normal follow-ups with a session_id, pass history as a separate field
    # so the sidecar can use it as fallback if resume fails.
    query_message = _build_message_with_history(message, conversation_history) if not session_id else message
    system_prompt = build_system_prompt(db)

    # Pass Langfuse credentials to the container so the sidecar's
    # TypeScript Langfuse SDK can create traces directly.
    env: dict[str, str] = {
        "ANTHROPIC_API_KEY": "placeholder",
        "ANTHROPIC_BASE_URL": f"{BACKEND_BASE_URL}/anthropic",
        "SDK_IDLE_TIMEOUT_MS": str(SDK_IDLE_TIMEOUT_MS),
    }
    if LANGFUSE_ENABLED:
        env["LANGFUSE_PUBLIC_KEY"] = LANGFUSE_PUBLIC_KEY
        env["LANGFUSE_SECRET_KEY"] = LANGFUSE_SECRET_KEY
        env["LANGFUSE_BASE_URL"] = LANGFUSE_BASE_URL

    # Use the backend session ID (X-Session-ID header) for both:
    # 1. MCP SSE URL — so the container queries the correct DuckDB instance
    # 2. Container lifecycle key — so the same container is reused across
    #    requests from the same browser tab (the Claude agent session_id
    #    changes after the first response, which would orphan the container)
    stable_session = backend_session_id or session_id or "default"

    # Declare persistence variables before try so they're accessible in finally
    assistant_text_parts: list[str] = []
    all_text_parts: list[str] = []
    assistant_metadata: dict = {"sql_queries": [], "chart_specs": []}
    persisted_segments: list[dict] = []
    seg_thinking_buf: list[str] = []
    seg_answer_buf: list[str] = []
    seg_phase = "thinking"
    actual_session_id = session_id

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
        container_manager.touch(stable_session)

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
            "model": ORCHESTRATOR_MODEL_SDK,
            "mcp_server_url": f"{BACKEND_BASE_URL}/mcp/sse?session_id={stable_session}",
            "env": {
                "ANTHROPIC_API_KEY": "placeholder",
                "ANTHROPIC_BASE_URL": f"{BACKEND_BASE_URL}/anthropic",
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
        # Always pass conversation_history so the sidecar can use it as fallback
        # if resume fails (e.g. container was recreated and session is gone).
        # Also pass original_message for Langfuse trace metadata.
        if conversation_history:
            payload["original_message"] = message
        payload["conversation_history"] = conversation_history or []
        if skills:
            payload["skills"] = skills

        stream_start_time = time.time()
        has_tool_calls = False
        has_thinking = False
        done_sent = False
        waiting_for_user = False
        tool_names: dict[str, str] = {}
        tool_sqls: dict[str, str] = {}
        # Track when ask_user_question was emitted (tool_id -> timestamp)
        question_asked_at: dict[str, float] = {}
        # Capture render_chart tool_use inputs so we can attach chart_spec
        # to the tool_result event (the MCP tool result itself may not echo
        # the full spec).
        tool_chart_specs: dict[str, dict] = {}
        # Track subagent text output from intermediate assistant messages.
        # The TypeScript SDK's Task tool_result contains only metadata (agentId,
        # usage), not the subagent's actual output.  The real output arrives in
        # assistant messages whose parent_tool_use_id matches the Task tool ID.
        subagent_texts: dict[str, str] = {}
        # Track SQL queries executed inside subagents so they can be
        # included in the subagent_end event for visibility.
        subagent_sql_data: dict[str, list[dict]] = {}  # parent_tool_use_id -> [{tool_id, sql, columns?, rows?, rowCount?}]
        subagent_internal_tools: dict[str, str] = {}   # tool_id -> parent_tool_use_id

        # Timeout must exceed SDK_IDLE_TIMEOUT_MS so the sidecar's own
        # idle abort fires first; add a 60s buffer.
        httpx_timeout = (SDK_IDLE_TIMEOUT_MS / 1000) + 60
        async with httpx.AsyncClient(timeout=httpx.Timeout(httpx_timeout)) as client:
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
                    except httpx.RemoteProtocolError:
                        # Sidecar closed the connection before sending a
                        # proper chunked-encoding terminator.  This is
                        # benign — the sidecar's Express handler calls
                        # res.end() in its finally block and the
                        # connection can tear down before the last chunk
                        # delimiter reaches us.  Treat it as end-of-stream.
                        logger.warning("Sidecar closed connection early (incomplete chunked read); treating as end-of-stream")
                        break

                    if not line.startswith("data: "):
                        continue
                    raw = line[6:]
                    waiting_for_user = False
                    try:
                        msg = json.loads(raw)
                    except json.JSONDecodeError:
                        continue

                    # Reset container idle timer on every message so
                    # long-running queries don't trigger the reaper.
                    container_manager.touch(stable_session)

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
                                    seg_thinking_buf.append(text)
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
                                    else:
                                        event_name = "answer" if has_tool_calls else "thinking"
                                        all_text_parts.append(text)
                                        # Track text in segment buffers based on actual phase
                                        if seg_phase == "thinking":
                                            seg_thinking_buf.append(text)
                                        else:
                                            seg_answer_buf.append(text)
                                        if event_name == "answer":
                                            assistant_text_parts.append(text)
                                        yield f"event: {event_name}\ndata: {json.dumps({'text': text})}\n\n"

                        elif event_type == "content_block_start":
                            block = event.get("content_block", {})
                            block_type = block.get("type")
                            if block_type == "thinking":
                                if not is_subagent_event:
                                    has_thinking = True
                            elif block_type == "text":
                                if has_thinking and not is_subagent_event:
                                    # Flush thinking buffer into a segment
                                    if seg_thinking_buf:
                                        persisted_segments.append({"type": "thinking", "text": "".join(seg_thinking_buf)})
                                        seg_thinking_buf.clear()
                                    seg_phase = "answer"
                                    yield f"event: thinking_done\ndata: {json.dumps({})}\n\n"
                            elif block_type == "tool_use":
                                if not is_subagent_event:
                                    # Flush thinking buffer before tool calls
                                    if seg_thinking_buf:
                                        persisted_segments.append({"type": "thinking", "text": "".join(seg_thinking_buf)})
                                        seg_thinking_buf.clear()
                                    seg_phase = "answer"
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

                        is_subagent_msg = bool(parent_tool_use_id and parent_tool_use_id in tool_names)
                        for block in message_obj.get("content", []):
                            block_type = block.get("type")
                            if block_type == "tool_use":
                                tool_id = block.get("id", "")
                                tool_name = block.get("name", "")
                                tool_input = block.get("input", {})
                                tool_names[tool_id] = tool_name

                                # Skip emitting tool_call for subagent-internal
                                # tools (execute_sql inside sql-analyst).  The
                                # SDK doesn't yield the matching tool_result
                                # user message, so the frontend would show
                                # "Executing..." forever.
                                if is_subagent_msg:
                                    subagent_internal_tools[tool_id] = parent_tool_use_id
                                    # Capture SQL for subagent_end visibility
                                    if "execute_sql" in tool_name:
                                        sql = tool_input.get("sql", "")
                                        if sql:
                                            subagent_sql_data.setdefault(parent_tool_use_id, []).append(
                                                {"tool_id": tool_id, "sql": sql}
                                            )
                                    continue

                                has_tool_calls = True
                                is_execute_sql = "execute_sql" in tool_name
                                is_render_chart = "render_chart" in tool_name
                                sql = tool_input.get("sql", "") if is_execute_sql else ""
                                if sql:
                                    tool_sqls[tool_id] = sql
                                # Capture render_chart input so we can attach
                                # chart_spec to the tool_result event.
                                if is_render_chart:
                                    tool_chart_specs[tool_id] = tool_input
                                tool_call_data: dict = {"id": tool_id, "name": tool_name}
                                if sql:
                                    tool_call_data["sql"] = sql
                                else:
                                    tool_call_data["input"] = tool_input
                                yield f"event: tool_call\ndata: {json.dumps(tool_call_data, default=str)}\n\n"
                                # Track tool segment for persistence (placeholder, updated on result)
                                persisted_segments.append({
                                    "type": "tool",
                                    "toolCallId": tool_id,
                                    "toolName": tool_name,
                                    "sql": sql or None,
                                })
                                if tool_name == "Task":
                                    subagent_name = tool_input.get("subagent_type", "unknown")
                                    subagent_prompt = tool_input.get("prompt", "")
                                    tool_names[tool_id] = subagent_name
                                    # Replace tool segment with subagent_start for subagent tools
                                    persisted_segments[-1] = {
                                        "type": "subagent_start",
                                        "subagentId": tool_id,
                                        "subagentName": subagent_name,
                                    }
                                    yield f"event: subagent_start\ndata: {json.dumps({'id': tool_id, 'name': subagent_name, 'prompt': subagent_prompt})}\n\n"

                                # Detect ask_user_question tool
                                if "ask_user_question" in tool_name:
                                    from app.pending_questions import pending_question_store
                                    import asyncio as _asyncio
                                    # Store the tool input on the tool segment for persistence
                                    for seg in persisted_segments:
                                        if seg.get("type") == "tool" and seg.get("toolCallId") == tool_id:
                                            seg["toolInput"] = tool_input
                                            break
                                    for _ in range(50):
                                        pending = pending_question_store.get_pending(stable_session)
                                        if pending:
                                            q_id = pending["question_id"]
                                            q_data = pending["data"]
                                            yield f"event: user_question\ndata: {json.dumps({'question_id': q_id, **q_data})}\n\n"
                                            waiting_for_user = True
                                            question_asked_at[tool_id] = time.time()
                                            # Append user_question segment (keep the tool segment for thinking block display)
                                            persisted_segments.append({
                                                "type": "user_question",
                                                "toolCallId": tool_id,
                                                "questionData": {
                                                    "questionId": q_id,
                                                    "question": q_data.get("question", ""),
                                                    "options": [
                                                        {"label": o.get("label", ""), **({"description": o["description"]} if o.get("description") else {})}
                                                        for o in q_data.get("options", [])
                                                    ],
                                                    "multiSelect": q_data.get("multi_select", False),
                                                },
                                            })
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

                            # Skip subagent-internal tool results; capture
                            # structured data for inclusion in subagent_end.
                            parent_subagent_id = subagent_internal_tools.get(tool_id)
                            if parent_subagent_id:
                                sa_name = tool_names.get(tool_id, "")
                                if "execute_sql" in sa_name:
                                    sa_parts = block.get("content", [])
                                    sa_text = ""
                                    if isinstance(sa_parts, list):
                                        for part in sa_parts:
                                            if isinstance(part, dict) and part.get("type") == "text":
                                                sa_text = part.get("text", "")
                                    elif isinstance(sa_parts, str):
                                        sa_text = sa_parts
                                    try:
                                        sa_parsed = json.loads(sa_text)
                                        for entry in subagent_sql_data.get(parent_subagent_id, []):
                                            if entry.get("tool_id") == tool_id:
                                                if sa_parsed.get("status") == "success":
                                                    entry["columns"] = sa_parsed.get("columns", [])
                                                    entry["rows"] = sa_parsed.get("rows", [])[:100]
                                                    entry["rowCount"] = sa_parsed.get("rowCount", 0)
                                                elif sa_parsed.get("status") == "error":
                                                    entry["error"] = sa_parsed.get("error", "")
                                                break
                                    except (json.JSONDecodeError, AttributeError):
                                        pass
                                continue

                            name = tool_names.get(tool_id, "")
                            content_parts = block.get("content", [])
                            text = ""
                            if isinstance(content_parts, list):
                                for part in content_parts:
                                    if isinstance(part, dict) and part.get("type") == "text":
                                        text = part.get("text", "")
                            elif isinstance(content_parts, str):
                                text = content_parts

                            # Handle ask_user_question result: capture answer and timing in persisted segment
                            if "ask_user_question" in name:
                                answered_at = time.time()
                                asked_at = question_asked_at.pop(tool_id, None)
                                duration_ms = int((answered_at - asked_at) * 1000) if asked_at else None
                                try:
                                    answer_parsed = json.loads(text)
                                    for seg in persisted_segments:
                                        if seg.get("type") == "user_question" and seg.get("toolCallId") == tool_id:
                                            seg["userAnswer"] = answer_parsed.get("answers", [])
                                            ft = answer_parsed.get("free_text")
                                            if ft:
                                                seg["userFreeText"] = ft
                                            if duration_ms is not None:
                                                seg["answerDurationMs"] = duration_ms
                                            break
                                except (json.JSONDecodeError, AttributeError):
                                    pass
                                # Also update the tool segment with the output text for thinking block display
                                for seg in persisted_segments:
                                    if seg.get("type") == "tool" and seg.get("toolCallId") == tool_id:
                                        seg["output"] = text
                                        break
                                result_evt: dict = {'id': tool_id, 'name': name, 'output': text}
                                if duration_ms is not None:
                                    result_evt['answer_duration_ms'] = duration_ms
                                yield f"event: tool_result\ndata: {json.dumps(result_evt, default=str)}\n\n"
                                continue

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
                            # Attach chart_spec from captured render_chart
                            # input so the frontend can render the chart.
                            # Only attach when the tool returned success — do
                            # NOT render a chart when the tool returned an
                            # error (e.g. empty traces), as the LLM expects
                            # the chart to have failed and may put its
                            # analysis in thinking instead of text output.
                            if tool_id in tool_chart_specs and "chart_spec" not in result_data and "error" not in result_data:
                                result_data["chart_spec"] = tool_chart_specs[tool_id]
                            # Detect subagent result (Task tool)
                            if name == "sql-analyst":
                                end_data: dict = {"id": tool_id, "name": name}
                                sql_data = subagent_sql_data.get(tool_id, [])
                                if sql_data:
                                    end_data["sql_results"] = [
                                        {k: v for k, v in entry.items() if k != "tool_id"}
                                        for entry in sql_data
                                    ]
                                narrative = subagent_texts.get(tool_id, "") or tool_use_result_text
                                if narrative:
                                    end_data["result"] = narrative
                                # Track subagent_end segment for persistence
                                persisted_segments.append({
                                    "type": "subagent_end",
                                    "subagentId": tool_id,
                                    "subagentName": name,
                                    "text": narrative or None,
                                    "sqlResults": end_data.get("sql_results"),
                                })
                                yield f"event: subagent_end\ndata: {json.dumps(end_data, default=str)}\n\n"
                                continue
                            # Accumulate SQL and chart data for persistence
                            if "columns" in result_data and "rows" in result_data:
                                assistant_metadata["sql_queries"].append({
                                    "sql": result_data.get("sql", ""),
                                    "columns": result_data.get("columns", []),
                                    "rowCount": result_data.get("rowCount", 0),
                                })
                            if "chart_spec" in result_data:
                                assistant_metadata["chart_specs"].append(result_data["chart_spec"])
                            # Update tool segment with result data for persistence
                            for seg in persisted_segments:
                                if seg.get("type") == "tool" and seg.get("toolCallId") == tool_id:
                                    seg["rowCount"] = result_data.get("rowCount")
                                    seg["error"] = result_data.get("error")
                                    if "columns" in result_data:
                                        seg["columns"] = result_data["columns"]
                                    if "rows" in result_data:
                                        seg["rows"] = result_data["rows"]
                                    if "chart_spec" in result_data:
                                        seg["chart_spec"] = result_data["chart_spec"]
                                    break
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
                        yield f"event: done\ndata: {json.dumps({'session_id': actual_session_id})}\n\n"
                        done_sent = True

                    # --- Extract session_id early from system init ---
                    elif msg_type == "system":
                        sys_session = msg.get("session_id")
                        if sys_session:
                            actual_session_id = sys_session

        # Guard: always send done even if sidecar ended without result message
        if not done_sent:
            logger.warning("Sidecar stream ended without result message; sending done event")
            yield f"event: error\ndata: {json.dumps({'message': 'Connection to agent was lost. Please try again.'})}\n\n"
            yield f"event: done\ndata: {json.dumps({'session_id': actual_session_id})}\n\n"

    except Exception as e:
        logger.error("Container agent error: %s", str(e))
        yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"
    finally:
        # Persist assistant message even when the client disconnects
        # (e.g. user switched conversations mid-stream).  Without this,
        # the assistant response would be lost on reload.
        text_to_persist = assistant_text_parts or all_text_parts
        if conversation_id and text_to_persist:
            try:
                # Finalize segments: flush remaining buffers
                if seg_thinking_buf:
                    persisted_segments.append({"type": "thinking", "text": "".join(seg_thinking_buf)})
                    seg_thinking_buf.clear()
                # Answer text: use seg_answer_buf (tracks post-thinking text)
                # or assistant_text_parts (tracks post-tool text), or fallback
                answer_text = "".join(seg_answer_buf) if seg_answer_buf else "".join(assistant_text_parts)
                if answer_text:
                    persisted_segments.append({"type": "answer", "text": answer_text})
                elif all_text_parts and not persisted_segments:
                    # No thinking blocks, no tool calls — all text is the answer
                    persisted_segments.append({"type": "answer", "text": "".join(all_text_parts)})

                meta = assistant_metadata.copy() if (assistant_metadata["sql_queries"] or assistant_metadata["chart_specs"]) else {}
                if persisted_segments:
                    meta["segments"] = persisted_segments
                meta["durationMs"] = int((time.time() - stream_start_time) * 1000)
                memory_store.add_message(
                    conversation_id, "assistant", "".join(text_to_persist),
                    metadata=meta if meta else None,
                )
            except Exception:
                logger.warning("Failed to persist assistant message", exc_info=True)
    # Note: Container is kept alive for session resume (--resume flag) and is
    # cleaned up by the background cleanup loop after
    # CONTAINER_MAX_LIFETIME_SECONDS, or on application shutdown.
