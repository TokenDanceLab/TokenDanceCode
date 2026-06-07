import subprocess
import tempfile
import unittest
from pathlib import Path

from tokendance.git.service import GitService


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True)


def _init_repo(repo: Path) -> None:
    _git(repo, "init")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Tokendance Test")


class GitServiceTests(unittest.TestCase):
    def test_status_diff_log_branch_and_worktree_list(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            _init_repo(repo)
            (repo / "notes.txt").write_text("old\n", encoding="utf-8")
            _git(repo, "add", "notes.txt")
            _git(repo, "commit", "-m", "initial")
            (repo / "notes.txt").write_text("old\nnew\n", encoding="utf-8")

            service = GitService(repo)
            status = service.status_short()
            diff = service.diff()
            log = service.log(limit=1)
            branch = service.current_branch()
            worktrees = service.worktree_list()

        self.assertIn("M notes.txt", status)
        self.assertIn("+new", diff)
        self.assertIn("initial", log)
        self.assertTrue(branch)
        self.assertEqual(len(worktrees), 1)
