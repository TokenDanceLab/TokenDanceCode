from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path


class TodoStoreTests(unittest.TestCase):
    def _load_api(self):
        try:
            from tokendance.tasks import TodoService, TodoStatus
        except ModuleNotFoundError as exc:
            self.fail(f"todo API is missing: {exc}")
        return TodoService, TodoStatus

    def test_todo_service_writes_updates_and_lists_session_todos_with_task_link(self) -> None:
        TodoService, TodoStatus = self._load_api()
        with tempfile.TemporaryDirectory() as tmp:
            session_dir = Path(tmp) / ".tokendance" / "sessions" / "session-1"
            service = TodoService(session_dir)

            todo = service.write(content="Draft task store", task_id="task-0001")
            service.update(todo.id, status=TodoStatus.IN_PROGRESS)
            service.update(todo.id, content="Draft and verify task store")

            reloaded = TodoService(session_dir).list()
            raw = json.loads((session_dir / "todos.json").read_text(encoding="utf-8"))

        self.assertEqual(len(reloaded), 1)
        self.assertEqual(reloaded[0].id, todo.id)
        self.assertEqual(reloaded[0].content, "Draft and verify task store")
        self.assertEqual(reloaded[0].status, TodoStatus.IN_PROGRESS)
        self.assertEqual(reloaded[0].task_id, "task-0001")
        self.assertEqual(raw["todos"][0]["id"], todo.id)

    def test_todo_service_rejects_unknown_status_and_missing_todo(self) -> None:
        TodoService, _TodoStatus = self._load_api()
        with tempfile.TemporaryDirectory() as tmp:
            service = TodoService(Path(tmp) / "session")
            todo = service.write(content="Keep visible")

            with self.assertRaisesRegex(ValueError, "Unknown todo status"):
                service.update(todo.id, status="waiting")
            with self.assertRaisesRegex(KeyError, "missing-todo"):
                service.update("missing-todo", status="completed")

            self.assertEqual(service.list()[0].content, "Keep visible")

