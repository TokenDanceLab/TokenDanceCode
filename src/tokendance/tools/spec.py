from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from tokendance.storage.transcript import TranscriptWriter


@dataclass
class ToolContext:
    workspace_root: Path
    permission_mode: str = "default"
    session_dir: Path | None = None
    transcript_writer: TranscriptWriter | None = None


@dataclass(frozen=True)
class ToolResult:
    status: str
    content: str
    data: dict[str, Any] | None = None
    artifact_ref: str | None = None

    @classmethod
    def ok(
        cls,
        *,
        content: str = "",
        data: dict[str, Any] | None = None,
        artifact_ref: str | None = None,
    ) -> "ToolResult":
        return cls(status="ok", content=content, data=data, artifact_ref=artifact_ref)

    @classmethod
    def error(cls, content: str) -> "ToolResult":
        return cls(status="error", content=content)


ToolHandler = Callable[[ToolContext, dict[str, Any]], ToolResult]


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    input_schema: dict[str, Any]
    permission_policy: str
    handler: ToolHandler
