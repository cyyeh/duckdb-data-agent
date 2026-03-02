import json
import logging
import anyio
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route, Mount
from mcp.server.sse import SseServerTransport
from mcp.server.lowlevel.server import Server as MCPServer
import mcp.types as types
from app.session_manager import session_manager
from app.database import Database
from app.pending_questions import pending_question_store
import os
from app.skills import create_skill as _create_skill_file, SkillValidationError
from app.agent_memory import read_memories, save_memory, forget_memory

SKILLS_DIR = os.environ.get("SKILLS_DIR", os.path.join(os.path.dirname(__file__), "..", "..", "skills"))

logger = logging.getLogger(__name__)

MAX_RESULT_ROWS = 100

# The path here is relative to the Starlette app mount point (/mcp), not the
# full URL.  Starlette sets root_path=/mcp in the ASGI scope, and the MCP SDK
# prepends root_path when advertising the endpoint URL to clients.  Using
# "/messages/" avoids a double-prefix (/mcp/mcp/messages/).
sse_transport = SseServerTransport("/messages/")


def _create_mcp_server(db: Database, session_id: str) -> MCPServer:
    """Create a duckdb-data-agent MCP server with execute_sql, ask_user_question, and render_chart tools bound to a DuckDB instance."""
    server = MCPServer("duckdb-data-agent")

    @server.list_tools()
    async def list_tools() -> list[types.Tool]:
        return [
            types.Tool(
                name="execute_sql",
                description=(
                    "Execute a SQL query against the DuckDB database. "
                    "Results are returned as JSON with columns, rows, and rowCount."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {"sql": {"type": "string"}},
                    "required": ["sql"],
                },
            ),
            types.Tool(
                name="ask_user_question",
                description=(
                    "Ask the user a clarifying question with selectable options. "
                    "Pauses until the user responds."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "question": {"type": "string"},
                        "options": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "label": {"type": "string"},
                                    "description": {"type": "string"},
                                },
                                "required": ["label"],
                            },
                        },
                        "multi_select": {
                            "type": "boolean",
                            "default": False,
                            "description": (
                                "Set to true when the user should be able to pick more than one option "
                                "(e.g. 'which charts do you want?' or 'select all that apply'). "
                                "Defaults to false (single-select)."
                            ),
                        },
                    },
                    "required": ["question", "options"],
                },
            ),
            types.Tool(
                name="render_chart",
                description=(
                    "Render a chart. For Plotly: pass `data` (array of traces) and `layout` (with title). "
                    "For Vega-Lite: pass `library` as \"vegalite\" and `spec` (full Vega-Lite spec with title)."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "library": {
                            "type": "string",
                            "enum": ["plotly", "vegalite"],
                            "default": "plotly",
                            "description": "Chart library to use: 'plotly' (default) or 'vegalite'",
                        },
                        "data": {
                            "type": "array",
                            "description": "Array of Plotly trace objects (for Plotly mode)",
                            "items": {"type": "object"},
                        },
                        "layout": {
                            "type": "object",
                            "description": "Plotly layout object (for Plotly mode)",
                            "properties": {
                                "title": {"type": "string"},
                            },
                            "required": ["title"],
                        },
                        "spec": {
                            "type": "object",
                            "description": "Full Vega-Lite specification (for Vega-Lite mode)",
                        },
                    },
                    "required": [],
                },
            ),
            types.Tool(
                name="create_skill",
                description=(
                    "Create a reusable skill (workflow template) that can be invoked later. "
                    "The skill is saved as a SKILL.md file and becomes available via /skill-name."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "Skill identifier in hyphen-case (e.g. 'my-analysis-workflow')",
                        },
                        "description": {
                            "type": "string",
                            "description": "What the skill does and when to use it (max 1024 chars)",
                        },
                        "content": {
                            "type": "string",
                            "description": "Full markdown body with step-by-step instructions",
                        },
                    },
                    "required": ["name", "description", "content"],
                },
            ),
            types.Tool(
                name="save_memory",
                description=(
                    "Save a piece of information to long-term memory so it persists across conversations. "
                    "Use this to remember user preferences, important facts, or recurring patterns."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "content": {
                            "type": "string",
                            "description": "The memory content to save (e.g. 'User prefers bar charts')",
                        },
                        "category": {
                            "type": "string",
                            "enum": ["preference", "fact", "pattern"],
                            "description": "Category of the memory: preference (user likes/dislikes), fact (important information), or pattern (recurring behavior)",
                        },
                    },
                    "required": ["content", "category"],
                },
            ),
            types.Tool(
                name="recall_memories",
                description=(
                    "Recall all saved memories, optionally filtered by a keyword query. "
                    "Use this at the start of a conversation to check for relevant context."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Optional keyword to filter memories (case-insensitive substring match)",
                        },
                    },
                },
            ),
            types.Tool(
                name="forget_memory",
                description=(
                    "Remove a specific memory entry. The content must match an existing memory exactly."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "content": {
                            "type": "string",
                            "description": "The exact memory content to forget (without the leading '- ')",
                        },
                    },
                    "required": ["content"],
                },
            ),
        ]

    @server.call_tool()
    async def call_tool(
        name: str, arguments: dict
    ) -> list[types.TextContent]:
        if name == "execute_sql":
            sql = arguments.get("sql", "")
            try:
                result = await db.execute_query_async(sql)
                truncated_rows = result["rows"][:MAX_RESULT_ROWS]
                result_json = {
                    "status": "success",
                    "columns": result["columns"],
                    "rows": truncated_rows,
                    "rowCount": result["rowCount"],
                }
                return [types.TextContent(type="text", text=json.dumps(result_json, default=str))]
            except Exception as e:
                error_json = {"status": "error", "error": str(e)}
                return [types.TextContent(type="text", text=json.dumps(error_json))]
        elif name == "ask_user_question":
            question_data = {
                "question": arguments.get("question", ""),
                "options": arguments.get("options", []),
                "multi_select": arguments.get("multi_select", False),
            }
            question_id = pending_question_store.create(session_id, question_data)
            answer = await pending_question_store.wait(session_id, question_id, timeout=300.0)
            if answer is None:
                result = {"timeout": True, "message": "User did not respond within the time limit."}
            else:
                result = answer
            return [types.TextContent(type="text", text=json.dumps(result))]
        elif name == "render_chart":
            library = arguments.get("library", "plotly")

            if library == "vegalite":
                spec = arguments.get("spec")
                if not isinstance(spec, dict):
                    return [types.TextContent(type="text", text=json.dumps({
                        "status": "error",
                        "error": "spec (Vega-Lite specification object) is required when library is 'vegalite'"
                    }))]
                # Check spec has data
                data_obj = spec.get("data", {})
                data_values = data_obj.get("values", []) if isinstance(data_obj, dict) else []
                if not data_values:
                    return [types.TextContent(type="text", text=json.dumps({
                        "status": "error",
                        "error": "Vega-Lite spec must contain data.values with at least one row."
                    }))]
                return [types.TextContent(type="text", text=json.dumps({
                    "status": "success",
                    "chart_spec": {"library": "vegalite", "spec": spec},
                }))]
            else:
                # Plotly path (existing logic)
                data = arguments.get("data")
                layout = arguments.get("layout", {})
                if not isinstance(data, list):
                    logger.warning("render_chart called with missing data: %s", arguments)
                    return [types.TextContent(type="text", text=json.dumps({"status": "error", "error": "data (array of Plotly traces) is required"}))]

                _DATA_FIELDS = ("x", "y", "z", "values", "labels", "lat", "lon", "r", "theta",
                                "lowerfence", "q1", "median", "q3", "upperfence")
                has_nonempty_trace = False
                for trace in data:
                    if not isinstance(trace, dict):
                        continue
                    for field in _DATA_FIELDS:
                        val = trace.get(field)
                        if isinstance(val, list) and len(val) > 0:
                            has_nonempty_trace = True
                            break
                    if has_nonempty_trace:
                        break
                if not has_nonempty_trace:
                    logger.warning("render_chart called with all-empty data traces: %s", arguments)
                    return [types.TextContent(type="text", text=json.dumps({
                        "status": "error",
                        "error": "All data traces are empty — no data to chart. "
                                 "Check your SQL query results before calling render_chart."
                    }))]
                return [types.TextContent(type="text", text=json.dumps({
                    "status": "success",
                    "chart_spec": {"library": "plotly", "data": data, "layout": layout},
                }))]
        elif name == "create_skill":
            skill_name = arguments.get("name", "")
            description = arguments.get("description", "")
            content = arguments.get("content", "")
            try:
                _create_skill_file(skill_name, description, content, SKILLS_DIR)
                return [types.TextContent(type="text", text=json.dumps({
                    "success": True,
                    "message": f"Skill '{skill_name}' created successfully. Users can now invoke it with /{skill_name}.",
                }))]
            except SkillValidationError as e:
                return [types.TextContent(type="text", text=json.dumps({
                    "success": False,
                    "error": str(e),
                }))]
        elif name == "save_memory":
            content = arguments.get("content", "")
            category = arguments.get("category", "fact")
            result = save_memory(content, category)
            return [types.TextContent(type="text", text=json.dumps({"status": "success", "message": result}))]
        elif name == "recall_memories":
            query = arguments.get("query", "")
            memories = read_memories()
            if query and memories:
                query_lower = query.lower()
                lines = memories.split("\n")
                result_lines: list[str] = []
                current_header: str | None = None
                section_entries: list[str] = []
                for line in lines:
                    if line.startswith("# "):
                        # Top-level header always included
                        if current_header and section_entries:
                            result_lines.append(current_header)
                            result_lines.append("")
                            result_lines.extend(section_entries)
                            result_lines.append("")
                        current_header = None
                        section_entries = []
                        result_lines.append(line)
                        result_lines.append("")
                    elif line.startswith("## "):
                        # Flush previous section if it had matches
                        if current_header and section_entries:
                            result_lines.append(current_header)
                            result_lines.append("")
                            result_lines.extend(section_entries)
                            result_lines.append("")
                        current_header = line
                        section_entries = []
                    elif line.startswith("- ") and query_lower in line.lower():
                        section_entries.append(line)
                # Flush last section
                if current_header and section_entries:
                    result_lines.append(current_header)
                    result_lines.append("")
                    result_lines.extend(section_entries)
                    result_lines.append("")
                memories = "\n".join(result_lines).strip()
            return [types.TextContent(type="text", text=json.dumps({"status": "success", "memories": memories}))]
        elif name == "forget_memory":
            content = arguments.get("content", "")
            result = forget_memory(content)
            return [types.TextContent(type="text", text=json.dumps({"status": "success", "message": result}))]
        else:
            raise ValueError(f"Unknown tool: {name}")

    return server


async def handle_sse(request: Request) -> Response:
    """Handle SSE connection. Requires session_id query param."""
    session_id = request.query_params.get("session_id")
    if not session_id:
        return Response("session_id query parameter is required", status_code=400)

    db = session_manager.get_or_create(session_id)
    server = _create_mcp_server(db, session_id)

    try:
        async with sse_transport.connect_sse(
            request.scope, request.receive, request._send
        ) as streams:
            await server.run(
                streams[0],
                streams[1],
                server.create_initialization_options(),
            )
    except anyio.ClosedResourceError:
        logger.debug("MCP SSE client disconnected (session %s)", session_id)
    except BaseExceptionGroup as eg:
        # The MCP library uses anyio task groups which wrap errors in
        # ExceptionGroups.  Filter out ClosedResourceError (normal client
        # disconnect) and re-raise anything else.
        _, rest = eg.split(anyio.ClosedResourceError)
        if rest:
            raise rest from None
        logger.debug("MCP SSE client disconnected (session %s)", session_id)

    return Response()


mcp_app = Starlette(
    routes=[
        Route("/sse", endpoint=handle_sse, methods=["GET"]),
        Mount("/messages/", app=sse_transport.handle_post_message),
    ]
)
