from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from tokendance.tools.spec import ToolContext


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True)


def _init_repo(repo: Path) -> None:
    _git(repo, "init")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Tokendance Test")
    (repo / "notes.txt").write_text("base\n", encoding="utf-8")
    _git(repo, "add", "notes.txt")
    _git(repo, "commit", "-m", "initial")


class SubagentToolTests(unittest.TestCase):
    def _specs(self):
        try:
            from tokendance.tools.subagent import build_subagent_tool_specs
        except ModuleNotFoundError as exc:
            self.fail(f"subagent tools are missing: {exc}")
        return {spec.name: spec for spec in build_subagent_tool_specs()}

    def test_subagent_tool_runs_readonly_investigator(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = self._specs()["subagent_run"].handler(
                ToolContext(workspace_root=root),
                {"prompt": "Inspect config", "agent_type": "investigator"},
            )

        self.assertEqual(result.status, "ok")
        self.assertIn("Inspect config", result.data["result"]["summary"])
        self.assertEqual(result.data["result"]["changed_files"], [])

    def test_worktree_tools_create_list_and_remove(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _init_repo(root)
            context = ToolContext(workspace_root=root)
            specs = self._specs()

            created = specs["worktree_create"].handler(context, {"name": "tool-wt"})
            listed = specs["worktree_list"].handler(context, {})
            removed = specs["worktree_remove"].handler(context, {"name": "tool-wt"})

        self.assertEqual(created.status, "ok")
        self.assertEqual(created.data["worktree"]["name"], "tool-wt")
        self.assertIn("tool-wt", [item["name"] for item in listed.data["worktrees"]])
        self.assertEqual(removed.status, "ok")


if __name__ == "__main__":
    unittest.main()
