from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from tokendance.tools.spec import ToolContext


class TaskToolTests(unittest.TestCase):
    def _task_specs(self):
        try:
            from tokendance.tools.task import build_task_tool_specs
        except ModuleNotFoundError as exc:
            self.fail(f"task tools are missing: {exc}")
        return {spec.name: spec for spec in build_task_tool_specs()}

    def test_task_tools_create_update_link_and_list_tasks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            context = ToolContext(
                workspace_root=root,
                session_dir=root / ".tokendance" / "sessions" / "session-1",
            )
            specs = self._task_specs()

            dependency = specs["task_create"].handler(context, {"title": "Dependency"})
            created = specs["task_create"].handler(
                context,
                {"title": "Implement tools", "description": "Task/todo ToolSpecs"},
            )
            task_id = created.data["task"]["id"]
            dependency_id = dependency.data["task"]["id"]
            status_result = specs["task_update_status"].handler(
                context,
                {"task_id": task_id, "status": "in_progress"},
            )
            dependency_result = specs["task_add_dependency"].handler(
                context,
                {"task_id": task_id, "dependency_id": dependency_id},
            )
            session_result = specs["task_link_session"].handler(context, {"task_id": task_id})
            worktree_result = specs["task_link_worktree"].handler(
                context,
                {"task_id": task_id, "worktree": "worktree-a"},
            )
            fetched = specs["task_get"].handler(context, {"task_id": task_id})
            listed = specs["task_list"].handler(context, {})

        self.assertEqual(created.status, "ok")
        self.assertEqual(status_result.data["task"]["status"], "in_progress")
        self.assertEqual(dependency_result.data["task"]["dependencies"], [dependency_id])
        self.assertEqual(session_result.data["task"]["sessions"], ["session-1"])
        self.assertEqual(worktree_result.data["task"]["worktrees"], ["worktree-a"])
        self.assertEqual(fetched.data["task"]["id"], task_id)
        self.assertEqual([task["id"] for task in listed.data["tasks"]], [dependency_id, task_id])

    def test_task_tool_returns_error_for_invalid_status(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            specs = self._task_specs()
            context = ToolContext(workspace_root=root)
            created = specs["task_create"].handler(context, {"title": "Validate tool errors"})

            result = specs["task_update_status"].handler(
                context,
                {"task_id": created.data["task"]["id"], "status": "done"},
            )

        self.assertEqual(result.status, "error")
        self.assertIn("Unknown task status", result.content)


class TodoToolTests(unittest.TestCase):
    def _todo_specs(self):
        try:
            from tokendance.tools.todo import build_todo_tool_specs
        except ModuleNotFoundError as exc:
            self.fail(f"todo tools are missing: {exc}")
        return {spec.name: spec for spec in build_todo_tool_specs()}

    def test_todo_tools_write_update_and_list_session_todos(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            context = ToolContext(
                workspace_root=root,
                session_dir=root / ".tokendance" / "sessions" / "session-1",
            )
            specs = self._todo_specs()

            written = specs["todo_write"].handler(
                context,
                {"content": "Wire task tools", "task_id": "task-0001"},
            )
            updated = specs["todo_update"].handler(
                context,
                {"todo_id": written.data["todo"]["id"], "status": "completed"},
            )
            listed = specs["todo_list"].handler(context, {})

        self.assertEqual(written.status, "ok")
        self.assertEqual(updated.data["todo"]["status"], "completed")
        self.assertEqual(listed.data["todos"][0]["task_id"], "task-0001")
        self.assertEqual(listed.data["todos"][0]["status"], "completed")

    def test_todo_tool_requires_session_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            specs = self._todo_specs()

            result = specs["todo_write"].handler(
                ToolContext(workspace_root=Path(tmp)),
                {"content": "No session"},
            )

        self.assertEqual(result.status, "error")
        self.assertIn("session_dir", result.content)
