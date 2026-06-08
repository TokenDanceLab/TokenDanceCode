from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4


@dataclass(frozen=True)
class SessionState:
    session_id: str
    project_path: Path
    started_at: str
    updated_at: str
    provider: str = "anthropic"
    model: str = "claude-sonnet-4-6"
    permission_mode: str = "default"
    mode: str = "work"
    transcript_path: str = "transcript.jsonl"
    latest_summary: str | None = None
    recent_event_cursor: int = 0
    active_task_ids: list[str] = field(default_factory=list)
    todo_state: list[dict[str, Any]] = field(default_factory=list)
    resume_state: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def new(
        cls,
        *,
        project_path: Path,
        session_id: str | None = None,
        provider: str = "anthropic",
        model: str = "claude-sonnet-4-6",
        permission_mode: str = "default",
        mode: str = "work",
    ) -> "SessionState":
        now = _now_iso()
        return cls(
            session_id=session_id or uuid4().hex,
            project_path=Path(project_path),
            started_at=now,
            updated_at=now,
            provider=provider,
            model=model,
            permission_mode=permission_mode,
            mode=mode,
        )

    def to_record(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "project_path": str(self.project_path),
            "started_at": self.started_at,
            "updated_at": self.updated_at,
            "provider": self.provider,
            "model": self.model,
            "permission_mode": self.permission_mode,
            "mode": self.mode,
            "transcript_path": self.transcript_path,
            "latest_summary": self.latest_summary,
            "recent_event_cursor": self.recent_event_cursor,
            "active_task_ids": self.active_task_ids,
            "todo_state": self.todo_state,
            "resume_state": self.resume_state,
        }

    @classmethod
    def from_record(cls, record: dict[str, Any]) -> "SessionState":
        values = dict(record)
        values["project_path"] = Path(values["project_path"])
        return cls(**values)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()
