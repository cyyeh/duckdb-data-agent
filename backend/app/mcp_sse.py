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

logger = logging.getLogger(__name__)

MAX_RESULT_ROWS = 100

sse_transport = SseServerTransport("/mcp/messages/")


def _create_mcp_server(db: Database) -> MCPServer:
    """Create an MCP server with execute_sql tool bound to a DuckDB instance."""
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
            )
        ]

    @server.call_tool()
    async def call_tool(
        name: str, arguments: dict
    ) -> list[types.TextContent]:
        if name != "execute_sql":
            raise ValueError(f"Unknown tool: {name}")
        sql = arguments.get("sql", "")
        try:
            result = db.execute_query(sql)
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

    return server


async def handle_sse(request: Request) -> Response:
    """Handle SSE connection. Requires session_id query param."""
    session_id = request.query_params.get("session_id")
    if not session_id:
        return Response("session_id query parameter is required", status_code=400)

    db = session_manager.get_or_create(session_id)
    server = _create_mcp_server(db)

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
