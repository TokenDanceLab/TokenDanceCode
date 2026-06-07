from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from tokendance.storage.atomic import atomic_write_text
from tokendance.storage.jsonl import append_jsonl, read_jsonl
from tokendance.storage.paths import resolve_project_dir
from tokendance.tasks.models import Task, TaskStatus, parse_task_status


class TaskEventStore:
    def __init__(self, project_root: Path) -> None:
        self.project_root = Path(project_root)
        self.tasks_dir = resolve_project_dir(self.project_root) / "tasks"
        self.events_path = self.tasks_dir / "tasks.jsonl"
        self.index_path = self.tasks_dir / "task-index.json"

    def load_tasks(self) -> dict[str, Task]:
        if self.index_path.exists():
            raw = json.loads(self.index_path.read_text(encoding="utf-8"))
            return {
                task_id: Task.from_dict({**task_data, "id": task_id})
                for task_id, task_data in raw.get("tasks", {}).items()
            }

        tasks = self.rebuild_index()
        if tasks:
            self.write_index(tasks)
        return tasks

    def rebuild_index(self) -> dict[str, Task]:
        tasks: dict[str, Task] = {}
        for event in read_jsonl(self.events_path):
            event_type = str(event.get("type", ""))
            task_id = str(event.get("task_id", ""))
            timestamp = str(event.get("timestamp", ""))
            payload = event.get("payload", {})
            if not isinstance(payload, dict) or not task_id:
                continue

            if event_type == "task_created":
                task_data = payload.get("task", payload)
                if isinstance(task_data, dict):
                    tasks[task_id] = Task.from_dict({**task_data, "id": task_id})
                continue

            task = tasks.get(task_id)
            if task is None:
                continue
            if event_type == "task_status_updated":
                task.status = parse_task_status(payload.get("status", task.status))
            elif event_type == "task_dependency_added":
                _append_unique(task.dependencies, str(payload.get("dependency_id", "")))
            elif event_type == "task_session_linked":
                _append_unique(task.sessions, str(payload.get("session_id", "")))
            elif event_type == "task_worktree_linked":
                _append_unique(task.worktrees, str(payload.get("worktree", "")))
            if timestamp:
                task.updated_at = timestamp
        return tasks

    def append_event(
        self,
        event_type: str,
        task_id: str,
        payload: dict[str, Any],
        *,
        timestamp: str | None = None,
    ) -> dict[str, Any]:
        event = {
            "type": event_type,
            "task_id": task_id,
            "timestamp": timestamp or utc_now(),
            "payload": payload,
        }
        append_jsonl(self.events_path, event)
        return event

    def write_index(self, tasks: dict[str, Task]) -> None:
        ordered_tasks = {
            task_id: task.to_dict()
            for task_id, task in sorted(tasks.items(), key=lambda item: item[1].created_at or item[0])
        }
        index = {
            "version": 1,
            "updated_at": utc_now(),
            "tasks": ordered_tasks,
        }
        atomic_write_text(
            self.index_path,
            json.dumps(index, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        )


class TaskService:
    def __init__(self, project_root: Path, store: TaskEventStore | None = None) -> None:
        self.store = store or TaskEventStore(project_root)

    def create(
        self,
        *,
        title: str,
        description: str = "",
        status: str | TaskStatus = TaskStatus.PENDING,
    ) -> Task:
        title = _required_text(title, "Task title")
        parsed_status = parse_task_status(status)
        tasks = self.store.load_tasks()
        now = utc_now()
        task = Task(
            id=_next_task_id(tasks),
            title=title,
            description=str(description),
            status=parsed_status,
            created_at=now,
            updated_at=now,
        )
        self.store.append_event("task_created", task.id, {"task": task.to_dict()}, timestamp=now)
        tasks[task.id] = task
        self.store.write_index(tasks)
        return task

    def list(self, *, status: str | TaskStatus | None = None) -> list[Task]:
        tasks = sorted(self.store.load_tasks().values(), key=lambda task: task.created_at or task.id)
        if status is None:
            return tasks
        parsed_status = parse_task_status(status)
        return [task for task in tasks if task.status == parsed_status]

    def get(self, task_id: str) -> Task:
        tasks = self.store.load_tasks()
        return _require_task(tasks, task_id)

    def update_status(self, task_id: str, status: str | TaskStatus) -> Task:
        parsed_status = parse_task_status(status)
        tasks = self.store.load_tasks()
        task = _require_task(tasks, task_id)
        now = utc_now()
        task.status = parsed_status
        task.updated_at = now
        self.store.append_event(
            "task_status_updated",
            task.id,
            {"status": task.status.value},
            timestamp=now,
        )
        self.store.write_index(tasks)
        return task

    def add_dependency(self, task_id: str, dependency_id: str) -> Task:
        tasks = self.store.load_tasks()
        task = _require_task(tasks, task_id)
        dependency = _require_task(tasks, dependency_id)
        if task.id == dependency.id:
            raise ValueError("Task cannot depend on itself.")

        if dependency.id not in task.dependencies:
            now = utc_now()
            task.dependencies.append(dependency.id)
            task.updated_at = now
            self.store.append_event(
                "task_dependency_added",
                task.id,
                {"dependency_id": dependency.id},
                timestamp=now,
            )
            self.store.write_index(tasks)
        return task

    def link_session(self, task_id: str, session_id: str) -> Task:
        session_id = _required_text(session_id, "Session id")
        tasks = self.store.load_tasks()
        task = _require_task(tasks, task_id)
        if session_id not in task.sessions:
            now = utc_now()
            task.sessions.append(session_id)
            task.updated_at = now
            self.store.append_event(
                "task_session_linked",
                task.id,
                {"session_id": session_id},
                timestamp=now,
            )
            self.store.write_index(tasks)
        return task

    def link_worktree(self, task_id: str, worktree: str) -> Task:
        worktree = _required_text(worktree, "Worktree")
        tasks = self.store.load_tasks()
        task = _require_task(tasks, task_id)
        if worktree not in task.worktrees:
            now = utc_now()
            task.worktrees.append(worktree)
            task.updated_at = now
            self.store.append_event(
                "task_worktree_linked",
                task.id,
                {"worktree": worktree},
                timestamp=now,
            )
            self.store.write_index(tasks)
        return task


def utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _next_task_id(tasks: dict[str, Task]) -> str:
    numbers = [
        int(match.group(1))
        for task_id in tasks
        if (match := re.fullmatch(r"task-(\d+)", task_id)) is not None
    ]
    return f"task-{(max(numbers, default=0) + 1):04d}"


def _required_text(value: str, label: str) -> str:
    text = str(value).strip()
    if not text:
        raise ValueError(f"{label} is required.")
    return text


def _require_task(tasks: dict[str, Task], task_id: str) -> Task:
    normalized = _required_text(task_id, "Task id")
    try:
        return tasks[normalized]
    except KeyError:
        raise KeyError(f"Task not found: {normalized}") from None


def _append_unique(items: list[str], value: str) -> None:
    if value and value not in items:
        items.append(value)

