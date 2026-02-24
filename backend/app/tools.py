import json
from typing import Any
from claude_agent_sdk import tool, create_sdk_mcp_server
from app.database import Database

MAX_RESULT_ROWS = 100


class DuckDBServer(dict):
    """Wraps McpSdkServerConfig (a TypedDict/dict) and exposes _tools for testing."""

    def __init__(self, config: dict, tools: list) -> None:
        super().__init__(config)
        self._tools = tools  # test-only: used by tests to introspect registered tools


def create_duckdb_server(db: Database) -> "DuckDBServer":
    @tool(
        "execute_sql",
        "Execute a SQL query against the DuckDB database. Use this to query loaded tables, "
        "create views, or run any valid DuckDB SQL. Results are returned as JSON with columns, "
        "rows, and rowCount.",
        {"sql": str},
    )
    async def execute_sql(args: dict[str, Any]) -> dict[str, Any]:
        sql = args["sql"]
        try:
            result = await db.execute_query_async(sql)
            truncated_rows = result["rows"][:MAX_RESULT_ROWS]
            result_json = {
                "status": "success",
                "columns": result["columns"],
                "rows": truncated_rows,
                "rowCount": result["rowCount"],
            }
            content_text = json.dumps(result_json, default=str)
            return {"content": [{"type": "text", "text": content_text}]}
        except Exception as e:
            error_json = {"status": "error", "error": str(e)}
            return {
                "content": [{"type": "text", "text": json.dumps(error_json)}],
                "is_error": True,
            }

    @tool(
        "generate_chart",
        "Generate an interactive Plotly chart to visualize data. Call this after execute_sql "
        "when a chart would help the user understand the data. Pass a complete Plotly figure "
        "spec: 'data' is a required array of Plotly trace objects (bar, scatter, pie, heatmap, "
        "box, violin, histogram, etc.), 'layout' is an optional object for title, axis labels, etc.",
        {"data": list, "layout": dict},
    )
    async def generate_chart(args: dict[str, Any]) -> dict[str, Any]:
        if not args.get("data"):
            error_json = {"status": "error", "error": "Missing required field: data"}
            return {"content": [{"type": "text", "text": json.dumps(error_json)}], "is_error": True}
        result_json = {
            "status": "success",
            "chart_spec": {
                "data": args["data"],
                "layout": args.get("layout", {}),
            },
        }
        return {"content": [{"type": "text", "text": json.dumps(result_json)}]}

    tools = [execute_sql, generate_chart]
    config = create_sdk_mcp_server(
        name="duckdb",
        version="1.0.0",
        tools=tools,
    )
    return DuckDBServer(config, tools)
