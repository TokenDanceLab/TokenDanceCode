from __future__ import annotations

from pathlib import Path
from typing import Any

from tokendance.tasks import Task, TaskService
from tokendance.tools.spec import ToolContext, ToolResult, ToolSpec


def task_create(context: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    try:
        task = TaskService(context.workspace_root).create(
            title=_required_arg(arguments, "title"),
            description=str(arguments.get("description", "")),
            status=arguments.get("status", "pending"),
        )
        return _task_result(task, f"Created task {task.id}")
    except (KeyError, ValueError) as exc:
        return ToolResult.error(str(exc))


def task_list(context: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    try:
        tasks = TaskService(context.workspace_root).list(status=arguments.get("status"))
        return ToolResult.ok(
            content="\n".join(_format_task(task) for task in tasks),
            data={"tasks": [task.to_dict() for task in tasks]},
        )
    except (KeyError, ValueError) as exc:
        return ToolResult.error(str(exc))


def task_get(context: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    try:
        task = TaskService(context.workspace_root).get(_required_arg(arguments, "task_id"))
        return _task_result(task, _format_task(task))
    except (KeyError, ValueError) as exc:
        return ToolResult.error(str(exc))


def task_update_status(context: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    try:
        task = TaskService(context.workspace_root).update_status(
            _required_arg(arguments, "task_id"),
            _required_arg(arguments, "status"),
        )
        return _task_result(task, f"Updated task {task.id} to {task.status.value}")
    except (KeyError, ValueError) as exc:
        return ToolResult.error(str(exc))


def task_add_dependency(context: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    try:
        task = TaskService(context.workspace_root).add_dependency(
            _required_arg(arguments, "task_id"),
            _required_arg(arguments, "dependency_id"),
        )
        return _task_result(task, f"Added dependency to {task.id}")
    except (KeyError, ValueError) as exc:
        return ToolResult.error(str(exc))


def task_link_session(context: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    try:
        session_id = arguments.get("session_id")
        if session_id is None or str(session_id).strip() == "":
            if context.session_dir is None:
                return ToolResult.error("session_id is required when context.session_dir is unavailable.")
            session_id = Path(context.session_dir).name
        task = TaskService(context.workspace_root).link_session(
            _required_arg(arguments, "task_id"),
            str(session_id),
        )
        return _task_result(task, f"Linked session {session_id} to {task.id}")
    except (KeyError, ValueError) as exc:
        return ToolResult.error(str(exc))


def task_link_worktree(context: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    try:
        worktree = arguments.get("worktree", arguments.get("path"))
        if worktree is None:
            raise ValueError("worktree is required.")
        task = TaskService(context.workspace_root).link_worktree(
            _required_arg(arguments, "task_id"),
            str(worktree),
        )
        return _task_result(task, f"Linked worktree to {task.id}")
    except (KeyError, ValueError) as exc:
        return ToolResult.error(str(exc))


def build_task_tool_specs() -> list[ToolSpec]:
    return [
        ToolSpec("task_create", "Create a persistent task.", _task_create_schema(), "write", task_create),
        ToolSpec("task_list", "List persistent tasks.", _task_list_schema(), "read", task_list),
        ToolSpec("task_get", "Get a persistent task.", _task_get_schema(), "read", task_get),
        ToolSpec(
            "task_update_status",
            "Update task status.",
            _task_update_status_schema(),
            "write",
            task_update_status,
        ),
        ToolSpec(
            "task_add_dependency",
            "Add a task dependency.",
            _task_add_dependency_schema(),
            "write",
            task_add_dependency,
        ),
        ToolSpec(
            "task_link_session",
            "Link a session to a task.",
            _task_link_session_schema(),
            "write",
            task_link_session,
        ),
        ToolSpec(
            "task_link_worktree",
            "Link a worktree to a task.",
            _task_link_worktree_schema(),
            "write",
            task_link_worktree,
        ),
    ]


def _task_result(task: Task, content: str) -> ToolResult:
    return ToolResult.ok(content=content, data={"task": task.to_dict()})


def _format_task(task: Task) -> str:
    return f"{task.id} [{task.status.value}] {task.title}"


def _required_arg(arguments: dict[str, Any], name: str) -> str:
    value = arguments.get(name)
    if value is None or str(value).strip() == "":
        raise ValueError(f"{name} is required.")
    return str(value).strip()


def _status_enum() -> list[str]:
    return ["pending", "in_progress", "blocked", "completed", "cancelled"]


def _task_create_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "description": {"type": "string"},
            "status": {"type": "string", "enum": _status_enum()},
        },
        "required": ["title"],
    }


def _task_list_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {"status": {"type": "string", "enum": _status_enum()}},
    }


def _task_get_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {"task_id": {"type": "string"}},
        "required": ["task_id"],
    }


def _task_update_status_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "task_id": {"type": "string"},
            "status": {"type": "string", "enum": _status_enum()},
        },
        "required": ["task_id", "status"],
    }


def _task_add_dependency_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "task_id": {"type": "string"},
            "dependency_id": {"type": "string"},
        },
        "required": ["task_id", "dependency_id"],
    }


def _task_link_session_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "task_id": {"type": "string"},
            "session_id": {"type": "string"},
        },
        "required": ["task_id"],
    }


def _task_link_worktree_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "task_id": {"type": "string"},
            "worktree": {"type": "string"},
            "path": {"type": "string"},
        },
        "required": ["task_id"],
    }

