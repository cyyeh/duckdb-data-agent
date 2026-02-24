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

# The path here is relative to the Starlette app mount point (/mcp), not the
# full URL.  Starlette sets root_path=/mcp in the ASGI scope, and the MCP SDK
# prepends root_path when advertising the endpoint URL to clients.  Using
# "/messages/" avoids a double-prefix (/mcp/mcp/messages/).
sse_transport = SseServerTransport("/messages/")


def _create_mcp_server(db: Database) -> MCPServer:
    """Create an MCP server with execute_sql and generate_chart tools bound to a DuckDB instance."""
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
                name="generate_chart",
                description=(
                    "Execute a SQL query and generate an interactive Plotly chart from the results. "
                    "Use after execute_sql when a visualization would help. "
                    "Parameters: sql (query to fetch chart data), chart_type (bar/scatter/line/pie/histogram/box/heatmap), "
                    "x_col (column for x-axis or pie labels), y_col (column for y-axis or pie values), "
                    "title (optional chart title), color_col (optional column for multi-series color grouping)."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "sql": {"type": "string"},
                        "chart_type": {"type": "string"},
                        "x_col": {"type": "string"},
                        "y_col": {"type": "string"},
                        "title": {"type": "string"},
                        "color_col": {"type": "string"},
                    },
                    "required": ["sql", "chart_type", "x_col", "y_col"],
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
        elif name == "generate_chart":
            sql = arguments.get("sql", "")
            chart_type = arguments.get("chart_type", "bar")
            x_col = arguments.get("x_col", "")
            y_col = arguments.get("y_col", "")
            title = arguments.get("title", "")
            color_col = arguments.get("color_col", "")

            if not sql:
                error_json = {"status": "error", "error": "Missing required field: sql"}
                return [types.TextContent(type="text", text=json.dumps(error_json))]

            try:
                result = await db.execute_query_async(sql)
            except Exception as e:
                error_json = {"status": "error", "error": str(e)}
                return [types.TextContent(type="text", text=json.dumps(error_json))]

            rows = result.get("rows", [])
            if not rows:
                error_json = {"status": "error", "error": "Query returned no rows to chart"}
                return [types.TextContent(type="text", text=json.dumps(error_json))]

            layout: dict = {}
            if title:
                layout["title"] = title

            if color_col and rows and color_col in rows[0]:
                groups: dict = {}
                for row in rows:
                    key = row.get(color_col)
                    if key not in groups:
                        groups[key] = []
                    groups[key].append(row)
                traces = []
                for group_key, group_rows in groups.items():
                    trace: dict = {"type": chart_type, "name": str(group_key)}
                    if chart_type == "pie":
                        if x_col:
                            trace["labels"] = [r.get(x_col) for r in group_rows]
                        if y_col:
                            trace["values"] = [r.get(y_col) for r in group_rows]
                    else:
                        if x_col:
                            trace["x"] = [r.get(x_col) for r in group_rows]
                        if y_col:
                            trace["y"] = [r.get(y_col) for r in group_rows]
                    traces.append(trace)
            else:
                trace = {"type": chart_type}
                if chart_type == "pie":
                    if x_col:
                        trace["labels"] = [r.get(x_col) for r in rows]
                    if y_col:
                        trace["values"] = [r.get(y_col) for r in rows]
                else:
                    if x_col:
                        trace["x"] = [r.get(x_col) for r in rows]
                    if y_col:
                        trace["y"] = [r.get(y_col) for r in rows]
                traces = [trace]

            result_json = {
                "status": "success",
                "chart_spec": {"data": traces, "layout": layout},
            }
            return [types.TextContent(type="text", text=json.dumps(result_json, default=str))]
        else:
            raise ValueError(f"Unknown tool: {name}")

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
