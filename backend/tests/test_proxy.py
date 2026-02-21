import time
from datetime import datetime, timedelta, timezone
from app.proxy import ProxyTokenStore


def test_create_token_returns_uuid_string():
    import uuid as uuid_module
    store = ProxyTokenStore()
    token = store.create_token()
    parsed = uuid_module.UUID(token)  # raises ValueError if not valid UUID
    assert parsed.version == 4


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
    store = ProxyTokenStore()
    token = store.create_token()
    # Backdate expiry directly — no sleep needed
    from datetime import timedelta, timezone
    store._tokens[token] = datetime.now(timezone.utc) - timedelta(seconds=1)
    assert store.validate_token(token) is False


def test_revoke_nonexistent_token_is_safe():
    store = ProxyTokenStore()
    store.revoke_token("ghost-token")  # must not raise
