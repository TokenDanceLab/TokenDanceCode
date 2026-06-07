from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class TaskStatus(str, Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    BLOCKED = "blocked"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class TodoStatus(str, Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    BLOCKED = "blocked"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


@dataclass
class Task:
    id: str
    title: str
    description: str = ""
    status: TaskStatus = TaskStatus.PENDING
    dependencies: list[str] = field(default_factory=list)
    sessions: list[str] = field(default_factory=list)
    worktrees: list[str] = field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "status": self.status.value,
            "dependencies": list(self.dependencies),
            "sessions": list(self.sessions),
            "worktrees": list(self.worktrees),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Task":
        return cls(
            id=str(data["id"]),
            title=str(data.get("title", "")),
            description=str(data.get("description", "")),
            status=parse_task_status(data.get("status", TaskStatus.PENDING)),
            dependencies=[str(item) for item in data.get("dependencies", [])],
            sessions=[str(item) for item in data.get("sessions", [])],
            worktrees=[str(item) for item in data.get("worktrees", [])],
            created_at=str(data.get("created_at", "")),
            updated_at=str(data.get("updated_at", "")),
        )


@dataclass
class TodoItem:
    id: str
    content: str
    status: TodoStatus = TodoStatus.PENDING
    task_id: str | None = None
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "content": self.content,
            "status": self.status.value,
            "task_id": self.task_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TodoItem":
        task_id = data.get("task_id")
        return cls(
            id=str(data["id"]),
            content=str(data.get("content", "")),
            status=parse_todo_status(data.get("status", TodoStatus.PENDING)),
            task_id=str(task_id) if task_id is not None else None,
            created_at=str(data.get("created_at", "")),
            updated_at=str(data.get("updated_at", "")),
        )


def parse_task_status(value: str | TaskStatus) -> TaskStatus:
    if isinstance(value, TaskStatus):
        return value
    try:
        return TaskStatus(str(value))
    except ValueError:
        raise ValueError(f"Unknown task status: {value}") from None


def parse_todo_status(value: str | TodoStatus) -> TodoStatus:
    if isinstance(value, TodoStatus):
        return value
    try:
        return TodoStatus(str(value))
    except ValueError:
        raise ValueError(f"Unknown todo status: {value}") from None

