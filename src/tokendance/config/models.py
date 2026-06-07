from __future__ import annotations

from dataclasses import dataclass, fields
from typing import Any, Literal

ProviderName = Literal["openai", "anthropic"]
PermissionMode = Literal["default", "safe", "auto", "yolo"]
ExecutorBackend = Literal["local", "venv", "conda", "docker", "worktree"]
ProjectState = Literal["local", "global", "disabled"]


@dataclass(frozen=True)
class TokendanceConfig:
    provider: ProviderName = "openai"
    model: str = "gpt-5.4"
    permission_mode: PermissionMode = "default"
    executor_backend: ExecutorBackend = "local"
    project_state: ProjectState = "local"

    @classmethod
    def from_mapping(cls, values: dict[str, Any]) -> "TokendanceConfig":
        allowed = {field.name for field in fields(cls)}
        unknown = sorted(set(values) - allowed)
        if unknown:
            joined = ", ".join(unknown)
            raise ValueError(f"Unknown config field(s): {joined}")
        return cls(**values)
