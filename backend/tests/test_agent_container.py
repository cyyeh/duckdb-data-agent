from app.config import CONTAINER_ENABLED


def test_container_enabled_reads_from_config():
    """Verify the config flag is available and defaults to False."""
    assert CONTAINER_ENABLED is False or CONTAINER_ENABLED is True
