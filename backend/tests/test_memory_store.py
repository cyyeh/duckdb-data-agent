import pytest
from app.memory_store import MemoryStore


@pytest.fixture
def store(tmp_path):
    db_path = str(tmp_path / "test.db")
    return MemoryStore(db_path)


def test_create_conversation_with_session_id(store):
    conv = store.create_conversation(session_id="sess-1", title="hello")
    assert conv["session_id"] == "sess-1"
    assert conv["title"] == "hello"


def test_list_conversations_filters_by_session(store):
    store.create_conversation(session_id="sess-1", title="a")
    store.create_conversation(session_id="sess-2", title="b")
    store.create_conversation(session_id="sess-1", title="c")

    result = store.list_conversations(session_id="sess-1")
    assert len(result) == 2
    titles = {r["title"] for r in result}
    assert titles == {"a", "c"}

    result2 = store.list_conversations(session_id="sess-2")
    assert len(result2) == 1
    assert result2[0]["title"] == "b"


def test_delete_conversations_by_session(store):
    store.create_conversation(session_id="sess-1", title="a")
    c2 = store.create_conversation(session_id="sess-2", title="b")
    store.create_conversation(session_id="sess-1", title="c")
    store.add_message(c2["id"], "user", "hi")

    deleted = store.delete_conversations_by_session("sess-1")
    assert deleted == 2

    # sess-2 untouched
    remaining = store.list_conversations(session_id="sess-2")
    assert len(remaining) == 1
    assert remaining[0]["title"] == "b"
    # messages for sess-2 still intact
    msgs = store.list_messages(c2["id"])
    assert len(msgs) == 1


def test_delete_conversations_by_session_cascades_messages(store):
    conv = store.create_conversation(session_id="sess-x", title="t")
    store.add_message(conv["id"], "user", "hello")
    store.add_message(conv["id"], "assistant", "world")

    store.delete_conversations_by_session("sess-x")

    # Conversation gone
    assert store.get_conversation(conv["id"]) is None
    # Messages also gone
    assert store.list_messages(conv["id"]) == []


def test_delete_conversations_by_session_empty_string_noop(store):
    store.create_conversation(session_id="", title="legacy")
    deleted = store.delete_conversations_by_session("")
    assert deleted == 0
    # legacy conversation still exists
    remaining = store.list_conversations(session_id="")
    assert len(remaining) == 1
