from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from tokendance.git.worktree import WorktreeService
from tokendance.tasks import TaskService


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True)


def _init_repo(repo: Path) -> None:
    _git(repo, "init")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Tokendance Test")
    (repo / "notes.txt").write_text("base\n", encoding="utf-8")
    _git(repo, "add", "notes.txt")
    _git(repo, "commit", "-m", "initial")


class WorktreeServiceTests(unittest.TestCase):
    def test_create_binds_task_lists_and_refuses_dirty_remove(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            _init_repo(repo)
            task = TaskService(repo).create(title="Isolated coding work")
            service = WorktreeService(repo)

            created = service.create("feature-a", task_id=task.id)
            linked_task = TaskService(repo).get(task.id)
            listed_names = [item.name for item in service.list()]
            main_status = subprocess.run(
                ["git", "status", "--short"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            ).stdout
            (created.path / "notes.txt").write_text("dirty\n", encoding="utf-8")
            refused = service.remove("feature-a")
            kept = service.keep("feature-a")
            removed = service.remove("feature-a", discard_changes=True)

        self.assertEqual(created.name, "feature-a")
        self.assertTrue(created.path.name.endswith("feature-a"))
        self.assertEqual(linked_task.worktrees, ["feature-a"])
        self.assertIn("feature-a", listed_names)
        self.assertEqual(main_status.strip(), "")
        self.assertFalse(refused.removed)
        self.assertIn("uncommitted", refused.message.lower())
        self.assertIn("kept", kept.message.lower())
        self.assertTrue(removed.removed)

    def test_remove_rejects_tampered_worktree_index(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            _init_repo(repo)
            service = WorktreeService(repo)
            service.create("feature-a")
            index = json.loads(service.index_path.read_text(encoding="utf-8"))
            index["worktrees"]["feature-a"]["path"] = str(repo)
            index["worktrees"]["feature-a"]["branch"] = "master"
            service.index_path.write_text(json.dumps(index), encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "outside managed worktree root"):
                service.remove("feature-a", discard_changes=True)

    def test_rejects_unsafe_worktree_names(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            _init_repo(repo)
            service = WorktreeService(repo)

            with self.assertRaisesRegex(ValueError, "Invalid worktree name"):
                service.create("../escape")


if __name__ == "__main__":
    unittest.main()
