from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone


@dataclass
class SandboxInfo:
    sandbox_id: str
    session_id: str
    url: str
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    last_activity: datetime | None = field(default=None)

    def __post_init__(self):
        if self.last_activity is None:
            self.last_activity = self.created_at


class SandboxBackend(ABC):
    @abstractmethod
    async def create(self, session_id: str, env: dict[str, str]) -> SandboxInfo:
        ...

    @abstractmethod
    def get(self, session_id: str) -> SandboxInfo | None:
        ...

    @abstractmethod
    def touch(self, session_id: str) -> None:
        ...

    @abstractmethod
    async def stop(self, session_id: str) -> None:
        ...

    @abstractmethod
    async def cleanup_expired(self) -> int:
        ...

    @abstractmethod
    async def shutdown_all(self) -> None:
        ...

    @abstractmethod
    async def cleanup_orphaned(self) -> int:
        ...
