import json
import logging
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

logger = logging.getLogger(__name__)

MAX_RESULT_ROWS = 100

# The path here is relative to the Starlette app mount point (/mcp), not the
# full URL.  Starlette sets root_path=/mcp in the ASGI scope, and the MCP SDK
# prepends root_path when advertising the endpoint URL to clients.  Using
# "/messages/" avoids a double-prefix (/mcp/mcp/messages/).
sse_transport = SseServerTransport("/messages/")


def _create_mcp_server(db: Database, session_id: str) -> MCPServer:
    """Create an MCP server with execute_sql and ask_user_question tools bound to a DuckDB instance."""
    server = MCPServer("duckdb")

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
                        "multi_select": {"type": "boolean", "default": False},
                    },
                    "required": ["question", "options"],
                },
            ),
            types.Tool(
                name="render_chart",
                description=(
                    "Render a Plotly chart. Call this as the final step after querying data. "
                    "Pass all Plotly traces in `data` and a layout object with a descriptive `title`."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "data": {
                            "type": "array",
                            "description": "Array of Plotly trace objects (bar, line, scatter, pie, etc.)",
                        },
                        "layout": {
                            "type": "object",
                            "description": "Plotly layout object",
                            "properties": {
                                "title": {"type": "string"},
                            },
                            "required": ["title"],
                        },
                    },
                    "required": ["data", "layout"],
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
            data = arguments.get("data")
            layout = arguments.get("layout", {})
            if not isinstance(data, list) or not layout.get("title"):
                logger.warning("render_chart called with missing data or layout.title: %s", arguments)
                return [types.TextContent(type="text", text=json.dumps({"status": "error", "error": "data and layout.title are required"}))]
            return [types.TextContent(type="text", text=json.dumps({"status": "rendered"}))]
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

    async with sse_transport.connect_sse(
        request.scope, request.receive, request._send
    ) as streams:
        await server.run(
            streams[0],
            streams[1],
            server.create_initialization_options(),
        )

    return Response()


mcp_app = Starlette(
    routes=[
        Route("/sse", endpoint=handle_sse, methods=["GET"]),
        Mount("/messages/", app=sse_transport.handle_post_message),
    ]
)
