# Project Notes

## Debugging

- No `logging.basicConfig()` or level configuration exists in the backend. Python defaults to WARNING level, so `logger.info()` and `logger.debug()` calls are silently suppressed. Use `print(..., flush=True)` for debug output that always shows in stdout.
