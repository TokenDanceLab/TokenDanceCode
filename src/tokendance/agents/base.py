from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any


class AgentType(str, Enum):
    INVESTIGATOR = "investigator"
    REVIEWER = "reviewer"
    CODING = "coding"


@dataclass(frozen=True)
class SubagentRequest:
    agent_id: str
    agent_type: AgentType
    prompt: str
    cwd: Path
    transcript_path: Path
    readonly: bool = True
    worktree: str | None = None
    task_id: str | None = None


@dataclass(frozen=True)
class SubagentOutput:
    summary: str
    changed_files: list[str] = field(default_factory=list)
    diff: str = ""
    validation_result: str = ""


@dataclass(frozen=True)
class AgentRunResult:
    agent_id: str
    agent_type: AgentType
    summary: str
    changed_files: list[str]
    diff: str
    validation_result: str
    transcript_path: Path
    worktree: str | None = None
    worktree_path: Path | None = None
    status: str = "completed"

    def to_dict(self) -> dict[str, Any]:
        return {
            "agent_id": self.agent_id,
            "agent_type": self.agent_type.value,
            "summary": self.summary,
            "changed_files": list(self.changed_files),
            "diff": self.diff,
            "validation_result": self.validation_result,
            "transcript_path": str(self.transcript_path),
            "worktree": self.worktree,
            "worktree_path": str(self.worktree_path) if self.worktree_path else None,
            "status": self.status,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AgentRunResult":
        transcript_path = Path(str(data["transcript_path"]))
        worktree_path = data.get("worktree_path")
        return cls(
            agent_id=str(data["agent_id"]),
            agent_type=AgentType(str(data["agent_type"])),
            summary=str(data.get("summary", "")),
            changed_files=[str(item) for item in data.get("changed_files", [])],
            diff=str(data.get("diff", "")),
            validation_result=str(data.get("validation_result", "")),
            transcript_path=transcript_path,
            worktree=str(data["worktree"]) if data.get("worktree") else None,
            worktree_path=Path(str(worktree_path)) if worktree_path else None,
            status=str(data.get("status", "completed")),
        )
