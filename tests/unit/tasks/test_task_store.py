from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path


class TaskStoreTests(unittest.TestCase):
    def _load_api(self):
        try:
            from tokendance.tasks import TaskService, TaskStatus
        except ModuleNotFoundError as exc:
            self.fail(f"task API is missing: {exc}")
        return TaskService, TaskStatus

    def test_task_service_persists_events_and_index_for_task_operations(self) -> None:
        TaskService, TaskStatus = self._load_api()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            service = TaskService(root)

            dependency = service.create(title="Write RED tests", description="Cover task MVP")
            task = service.create(title="Implement task store", description="Stage 12 MVP")
            service.update_status(task.id, TaskStatus.IN_PROGRESS)
            service.add_dependency(task.id, dependency.id)
            service.link_session(task.id, "session-1")
            service.link_worktree(task.id, "worktree-a")

            reloaded = TaskService(root).get(task.id)
            listed = TaskService(root).list()
            events_path = root / ".tokendance" / "tasks" / "tasks.jsonl"
            index_path = root / ".tokendance" / "tasks" / "task-index.json"
            events = [json.loads(line) for line in events_path.read_text(encoding="utf-8").splitlines()]
            index = json.loads(index_path.read_text(encoding="utf-8"))

        self.assertEqual(reloaded.status, TaskStatus.IN_PROGRESS)
        self.assertEqual(reloaded.dependencies, [dependency.id])
        self.assertEqual(reloaded.sessions, ["session-1"])
        self.assertEqual(reloaded.worktrees, ["worktree-a"])
        self.assertEqual([item.id for item in listed], [dependency.id, task.id])
        self.assertEqual(
            [event["type"] for event in events],
            [
                "task_created",
                "task_created",
                "task_status_updated",
                "task_dependency_added",
                "task_session_linked",
                "task_worktree_linked",
            ],
        )
        self.assertEqual(index["tasks"][task.id]["status"], "in_progress")
        self.assertEqual(index["tasks"][task.id]["dependencies"], [dependency.id])

    def test_task_service_rejects_unknown_status_and_missing_dependencies(self) -> None:
        TaskService, TaskStatus = self._load_api()
        with tempfile.TemporaryDirectory() as tmp:
            service = TaskService(Path(tmp))
            task = service.create(title="Validate errors")

            with self.assertRaisesRegex(ValueError, "Unknown task status"):
                service.update_status(task.id, "done")
            with self.assertRaisesRegex(KeyError, "missing-task"):
                service.add_dependency(task.id, "missing-task")
            with self.assertRaisesRegex(KeyError, "missing-task"):
                service.get("missing-task")

            self.assertEqual(service.get(task.id).status, TaskStatus.PENDING)

