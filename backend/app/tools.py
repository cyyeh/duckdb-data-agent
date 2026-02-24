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
        "Execute a SQL query and generate an interactive Plotly chart from the results. "
        "Use after execute_sql when a visualization would help. "
        "Parameters: sql (query to fetch chart data), chart_type (bar/scatter/line/pie/histogram/box/heatmap), "
        "x_col (column name for x-axis, or labels for pie), y_col (column name for y-axis, or values for pie), "
        "title (optional chart title), color_col (optional column for multi-series color grouping).",
        {"sql": str, "chart_type": str, "x_col": str, "y_col": str},
    )
    async def generate_chart(args: dict[str, Any]) -> dict[str, Any]:
        sql = args.get("sql", "")
        chart_type = args.get("chart_type", "bar")
        x_col = args.get("x_col", "")
        y_col = args.get("y_col", "")
        title = args.get("title", "")
        color_col = args.get("color_col", "")

        if not sql:
            error_json = {"status": "error", "error": "Missing required field: sql"}
            return {"content": [{"type": "text", "text": json.dumps(error_json)}], "is_error": True}

        try:
            result = await db.execute_query_async(sql)
        except Exception as e:
            error_json = {"status": "error", "error": str(e)}
            return {"content": [{"type": "text", "text": json.dumps(error_json)}], "is_error": True}

        rows = result.get("rows", [])
        if not rows:
            error_json = {"status": "error", "error": "Query returned no rows to chart"}
            return {"content": [{"type": "text", "text": json.dumps(error_json)}], "is_error": True}

        layout: dict[str, Any] = {}
        if title:
            layout["title"] = title

        if color_col and rows and color_col in rows[0]:
            # Multi-series: group rows by color_col
            groups: dict[Any, list] = {}
            for row in rows:
                key = row.get(color_col)
                if key not in groups:
                    groups[key] = []
                groups[key].append(row)
            traces = []
            for group_key, group_rows in groups.items():
                trace: dict[str, Any] = {"type": chart_type, "name": str(group_key)}
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
        return {"content": [{"type": "text", "text": json.dumps(result_json, default=str)}]}

    tools = [execute_sql, generate_chart]
    config = create_sdk_mcp_server(
        name="duckdb",
        version="1.0.0",
        tools=tools,
    )
    return DuckDBServer(config, tools)
