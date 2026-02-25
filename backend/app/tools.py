import json
from typing import Any
from claude_agent_sdk import tool, create_sdk_mcp_server
from app.database import Database
from app.pending_questions import pending_question_store

MAX_RESULT_ROWS = 100


class DuckDBServer(dict):
    """Wraps McpSdkServerConfig (a TypedDict/dict) and exposes _tools for testing."""

    def __init__(self, config: dict, tools: list) -> None:
        super().__init__(config)
        self._tools = tools


def create_duckdb_server(db: Database, session_id: str = "default") -> "DuckDBServer":
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
        "ask_user_question",
        "Ask the user a clarifying question with selectable options. Use this when the user's "
        "request is ambiguous or when you need to choose between multiple valid approaches. "
        "The tool will pause and wait for the user to select an option before continuing. "
        "Always provide clear, concise options. The user can also type a free-text response.",
        {
            "type": "object",
            "properties": {
                "question": {"type": "string", "description": "The question to ask the user"},
                "options": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "List of option strings the user can select from",
                },
                "multi_select": {
                    "type": "boolean",
                    "description": "Whether the user can select multiple options",
                },
            },
            "required": ["question", "options"],
        },
    )
    async def ask_user_question(args: dict[str, Any]) -> dict[str, Any]:
        question_data = {
            "question": args["question"],
            "options": args.get("options", []),
            "multi_select": args.get("multi_select", False),
        }
        timeout = args.get("timeout", 300.0)  # Internal override for testing
        question_id = pending_question_store.create(session_id, question_data)
        answer = await pending_question_store.wait(session_id, question_id, timeout=timeout)
        if answer is None:
            result = {"timeout": True, "message": "User did not respond within the time limit."}
        else:
            result = answer
        return {"content": [{"type": "text", "text": json.dumps(result)}]}

    tools = [execute_sql, ask_user_question]
    config = create_sdk_mcp_server(
        name="duckdb",
        version="1.0.0",
        tools=tools,
    )
    return DuckDBServer(config, tools)
