import asyncio
import pytest
from app.pending_questions import PendingQuestionStore


@pytest.fixture
def store():
    return PendingQuestionStore()


def test_create_returns_question_id(store):
    """create() returns a unique question_id string."""
    qid = store.create("session-1", {"question": "Pick one", "options": []})
    assert isinstance(qid, str)
    assert len(qid) > 0


def test_create_stores_question_data(store):
    """create() stores the question data retrievable by get_pending()."""
    qid = store.create("session-1", {"question": "Pick one", "options": [{"label": "A"}]})
    pending = store.get_pending("session-1")
    assert pending is not None
    assert pending["question_id"] == qid
    assert pending["data"]["question"] == "Pick one"


def test_respond_sets_answer(store):
    """respond() stores the answer for the given question."""
    qid = store.create("session-1", {"question": "Pick one", "options": []})
    store.respond("session-1", qid, {"answers": ["A"]})
    # The event should be set (wait returns immediately)


@pytest.mark.asyncio
async def test_wait_returns_answer_after_respond(store):
    """wait() returns the answer once respond() is called."""
    qid = store.create("session-1", {"question": "Pick one", "options": []})

    async def respond_later():
        await asyncio.sleep(0.05)
        store.respond("session-1", qid, {"answers": ["B"]})

    asyncio.create_task(respond_later())
    answer = await store.wait("session-1", qid, timeout=5.0)
    assert answer == {"answers": ["B"]}


@pytest.mark.asyncio
async def test_wait_timeout_returns_none(store):
    """wait() returns None when timeout expires without a response."""
    qid = store.create("session-1", {"question": "Pick", "options": []})
    answer = await store.wait("session-1", qid, timeout=0.1)
    assert answer is None


def test_cleanup_removes_session(store):
    """cleanup() removes all pending questions for a session."""
    store.create("session-1", {"question": "Pick", "options": []})
    store.cleanup("session-1")
    assert store.get_pending("session-1") is None


def test_respond_wrong_question_id_is_noop(store):
    """respond() with wrong question_id does nothing."""
    store.create("session-1", {"question": "Pick", "options": []})
    store.respond("session-1", "wrong-id", {"answers": ["A"]})
    # No error, just ignored


def test_multiple_sessions_independent(store):
    """Questions from different sessions don't interfere."""
    qid1 = store.create("session-1", {"question": "Q1", "options": []})
    qid2 = store.create("session-2", {"question": "Q2", "options": []})
    assert qid1 != qid2
    assert store.get_pending("session-1")["data"]["question"] == "Q1"
    assert store.get_pending("session-2")["data"]["question"] == "Q2"
