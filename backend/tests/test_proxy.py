import time
from app.proxy import ProxyTokenStore


def test_create_token_returns_uuid_string():
    store = ProxyTokenStore()
    token = store.create_token()
    assert isinstance(token, str)
    assert len(token) == 36  # UUID format


def test_valid_token_passes_validation():
    store = ProxyTokenStore()
    token = store.create_token()
    assert store.validate_token(token) is True


def test_unknown_token_fails_validation():
    store = ProxyTokenStore()
    assert store.validate_token("not-a-real-token") is False


def test_revoked_token_fails_validation():
    store = ProxyTokenStore()
    token = store.create_token()
    store.revoke_token(token)
    assert store.validate_token(token) is False


def test_expired_token_fails_validation():
    store = ProxyTokenStore(ttl_seconds=0)
    token = store.create_token()
    time.sleep(0.01)
    assert store.validate_token(token) is False


def test_revoke_nonexistent_token_is_safe():
    store = ProxyTokenStore()
    store.revoke_token("ghost-token")  # must not raise
