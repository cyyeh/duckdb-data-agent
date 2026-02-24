import json
import pytest
from unittest.mock import MagicMock, patch


@pytest.mark.asyncio
async def test_stream_chat_uses_subagents_and_task_tool():
    """stream_chat should configure ClaudeAgentOptions with subagents and Task tool."""
    from app.database import Database
    db = MagicMock(spec=Database)
    db.list_tables.return_value = []

    captured_options = {}

    class FakeClient:
        def __init__(self, options=None):
            captured_options["options"] = options

        async def connect(self):
            pass

        async def query(self, msg, session_id=None):
            pass

        async def receive_response(self):
            from claude_agent_sdk.types import ResultMessage
            yield ResultMessage(
                type="result",
                subtype="success",
                session_id="test-session",
                is_error=False,
                result="",
                errors=[],
                duration_ms=100,
                duration_api_ms=80,
                num_turns=1,
                cost=None,
            )

        async def disconnect(self):
            pass

    with patch("app.agent.ClaudeSDKClient", FakeClient), \
         patch("app.agent.proxy_token_store") as mock_proxy:
        mock_proxy.create_token.return_value = "fake-token"
        mock_proxy.revoke_token = MagicMock()

        from app.agent import stream_chat
        events = []
        async for event in stream_chat("test", db=db):
            events.append(event)

    opts = captured_options["options"]
    assert "Task" in opts.allowed_tools
    assert "mcp__duckdb__execute_sql" in opts.allowed_tools
    assert opts.agents is not None
    assert "sql-analyst" in opts.agents
    assert "chart-builder" in opts.agents


@pytest.mark.asyncio
async def test_stream_chat_emits_subagent_start_for_task_tool():
    """When the agent calls Task tool, stream_chat should emit subagent_start SSE event."""
    from app.database import Database
    db = MagicMock(spec=Database)
    db.list_tables.return_value = []

    class FakeClient:
        def __init__(self, options=None):
            pass

        async def connect(self):
            pass

        async def query(self, msg, session_id=None):
            pass

        async def receive_response(self):
            from claude_agent_sdk import AssistantMessage, ToolUseBlock
            from claude_agent_sdk.types import ResultMessage

            yield AssistantMessage(
                content=[
                    ToolUseBlock(
                        id="task_1",
                        name="Task",
                        input={
                            "subagent_type": "sql-analyst",
                            "description": "Run SQL query",
                            "prompt": "Find top products",
                        },
                    )
                ],
                model="claude-sonnet-4-20250514",
            )
            yield ResultMessage(
                type="result",
                subtype="success",
                session_id="test-session",
                is_error=False,
                result="",
                errors=[],
                duration_ms=100,
                duration_api_ms=80,
                num_turns=1,
                cost=None,
            )

        async def disconnect(self):
            pass

    with patch("app.agent.ClaudeSDKClient", FakeClient), \
         patch("app.agent.proxy_token_store") as mock_proxy:
        mock_proxy.create_token.return_value = "fake-token"
        mock_proxy.revoke_token = MagicMock()

        from app.agent import stream_chat
        events = []
        async for event in stream_chat("test", db=db):
            events.append(event)

    subagent_events = [e for e in events if "subagent_start" in e]
    assert len(subagent_events) >= 1
    data_line = subagent_events[0].split("data: ")[1].strip()
    parsed = json.loads(data_line)
    assert parsed["name"] == "sql-analyst"
    assert parsed["id"] == "task_1"
