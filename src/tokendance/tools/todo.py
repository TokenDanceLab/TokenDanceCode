from __future__ import annotations

from typing import Any

from tokendance.tasks import TodoItem, TodoService
from tokendance.tools.spec import ToolContext, ToolResult, ToolSpec


def todo_write(context: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    service_result = _todo_service(context)
    if isinstance(service_result, ToolResult):
        return service_result
    try:
        todo = service_result.write(
            content=_required_arg(arguments, "content"),
            task_id=arguments.get("task_id"),
            status=arguments.get("status", "pending"),
        )
        return _todo_result(todo, f"Wrote todo {todo.id}")
    except (KeyError, ValueError) as exc:
        return ToolResult.error(str(exc))


def todo_update(context: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    service_result = _todo_service(context)
    if isinstance(service_result, ToolResult):
        return service_result
    try:
        updates: dict[str, Any] = {}
        if "content" in arguments:
            updates["content"] = arguments["content"]
        if "status" in arguments:
            updates["status"] = arguments["status"]
        if "task_id" in arguments:
            updates["task_id"] = arguments["task_id"]
        todo = service_result.update(_required_arg(arguments, "todo_id"), **updates)
        return _todo_result(todo, f"Updated todo {todo.id}")
    except (KeyError, ValueError) as exc:
        return ToolResult.error(str(exc))


def todo_list(context: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    service_result = _todo_service(context)
    if isinstance(service_result, ToolResult):
        return service_result
    try:
        todos = service_result.list(
            status=arguments.get("status"),
            task_id=arguments.get("task_id"),
        )
        return ToolResult.ok(
            content="\n".join(_format_todo(todo) for todo in todos),
            data={"todos": [todo.to_dict() for todo in todos]},
        )
    except (KeyError, ValueError) as exc:
        return ToolResult.error(str(exc))


def build_todo_tool_specs() -> list[ToolSpec]:
    return [
        ToolSpec("todo_write", "Write a session todo.", _todo_write_schema(), "write", todo_write),
        ToolSpec("todo_update", "Update a session todo.", _todo_update_schema(), "write", todo_update),
        ToolSpec("todo_list", "List session todos.", _todo_list_schema(), "read", todo_list),
    ]


def _todo_service(context: ToolContext) -> TodoService | ToolResult:
    if context.session_dir is None:
        return ToolResult.error("todo tools require context.session_dir.")
    return TodoService(context.session_dir)


def _todo_result(todo: TodoItem, content: str) -> ToolResult:
    return ToolResult.ok(content=content, data={"todo": todo.to_dict()})


def _format_todo(todo: TodoItem) -> str:
    task = f" task={todo.task_id}" if todo.task_id else ""
    return f"{todo.id} [{todo.status.value}]{task} {todo.content}"


def _required_arg(arguments: dict[str, Any], name: str) -> str:
    value = arguments.get(name)
    if value is None or str(value).strip() == "":
        raise ValueError(f"{name} is required.")
    return str(value).strip()


def _status_enum() -> list[str]:
    return ["pending", "in_progress", "blocked", "completed", "cancelled"]


def _todo_write_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "content": {"type": "string"},
            "task_id": {"type": "string"},
            "status": {"type": "string", "enum": _status_enum()},
        },
        "required": ["content"],
    }


def _todo_update_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "todo_id": {"type": "string"},
            "content": {"type": "string"},
            "task_id": {"type": "string"},
            "status": {"type": "string", "enum": _status_enum()},
        },
        "required": ["todo_id"],
    }


def _todo_list_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "task_id": {"type": "string"},
            "status": {"type": "string", "enum": _status_enum()},
        },
    }
