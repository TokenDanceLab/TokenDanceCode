from __future__ import annotations

import json
import re
from pathlib import Path

from tokendance.storage.atomic import atomic_write_text
from tokendance.tasks.models import TodoItem, TodoStatus, parse_todo_status
from tokendance.tasks.store import utc_now

_UNSET = object()


class TodoStore:
    def __init__(self, session_dir: Path) -> None:
        self.session_dir = Path(session_dir)
        self.todos_path = self.session_dir / "todos.json"

    def load(self) -> list[TodoItem]:
        if not self.todos_path.exists():
            return []
        raw = json.loads(self.todos_path.read_text(encoding="utf-8"))
        return [TodoItem.from_dict(item) for item in raw.get("todos", [])]

    def save(self, todos: list[TodoItem]) -> None:
        data = {
            "version": 1,
            "updated_at": utc_now(),
            "todos": [todo.to_dict() for todo in todos],
        }
        atomic_write_text(
            self.todos_path,
            json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        )


class TodoService:
    def __init__(self, session_dir: Path, store: TodoStore | None = None) -> None:
        self.store = store or TodoStore(session_dir)

    def write(
        self,
        *,
        content: str,
        task_id: str | None = None,
        status: str | TodoStatus = TodoStatus.PENDING,
    ) -> TodoItem:
        content = _required_text(content, "Todo content")
        parsed_status = parse_todo_status(status)
        todos = self.store.load()
        now = utc_now()
        todo = TodoItem(
            id=_next_todo_id(todos),
            content=content,
            status=parsed_status,
            task_id=_optional_text(task_id),
            created_at=now,
            updated_at=now,
        )
        todos.append(todo)
        self.store.save(todos)
        return todo

    def update(
        self,
        todo_id: str,
        *,
        content: str | None = None,
        status: str | TodoStatus | None = None,
        task_id: str | None | object = _UNSET,
    ) -> TodoItem:
        todos = self.store.load()
        todo = _require_todo(todos, todo_id)
        if content is not None:
            todo.content = _required_text(content, "Todo content")
        if status is not None:
            todo.status = parse_todo_status(status)
        if task_id is not _UNSET:
            todo.task_id = _optional_text(task_id if task_id is None else str(task_id))
        todo.updated_at = utc_now()
        self.store.save(todos)
        return todo

    def list(
        self,
        *,
        status: str | TodoStatus | None = None,
        task_id: str | None = None,
    ) -> list[TodoItem]:
        todos = self.store.load()
        if status is not None:
            parsed_status = parse_todo_status(status)
            todos = [todo for todo in todos if todo.status == parsed_status]
        if task_id is not None:
            todos = [todo for todo in todos if todo.task_id == str(task_id)]
        return todos


def _next_todo_id(todos: list[TodoItem]) -> str:
    numbers = [
        int(match.group(1))
        for todo in todos
        if (match := re.fullmatch(r"todo-(\d+)", todo.id)) is not None
    ]
    return f"todo-{(max(numbers, default=0) + 1):04d}"


def _required_text(value: str, label: str) -> str:
    text = str(value).strip()
    if not text:
        raise ValueError(f"{label} is required.")
    return text


def _optional_text(value: str | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _require_todo(todos: list[TodoItem], todo_id: str) -> TodoItem:
    normalized = _required_text(todo_id, "Todo id")
    for todo in todos:
        if todo.id == normalized:
            return todo
    raise KeyError(f"Todo not found: {normalized}")

