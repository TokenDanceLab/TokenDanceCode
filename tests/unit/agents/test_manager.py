from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from tokendance.agents import AgentManager, AgentType, SubagentOutput


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True)


def _init_repo(repo: Path) -> None:
    _git(repo, "init")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Tokendance Test")
    (repo / "notes.txt").write_text("base\n", encoding="utf-8")
    _git(repo, "add", "notes.txt")
    _git(repo, "commit", "-m", "initial")


class AgentManagerTests(unittest.TestCase):
    def test_readonly_subagent_returns_summary_and_records_transcript(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            def runner(request):
                self.assertEqual(request.agent_type, AgentType.INVESTIGATOR)
                self.assertTrue(request.readonly)
                return SubagentOutput(summary=f"inspected: {request.prompt}")

            result = AgentManager(root, runner=runner).run_readonly(
                "Inspect the task store",
                agent_type=AgentType.INVESTIGATOR,
            )
            records = [
                json.loads(line)
                for line in result.transcript_path.read_text(encoding="utf-8").splitlines()
            ]

        self.assertEqual(result.agent_type, AgentType.INVESTIGATOR)
        self.assertIn("Inspect the task store", result.summary)
        self.assertEqual(result.changed_files, [])
        self.assertEqual(result.diff, "")
        self.assertEqual([record["type"] for record in records], ["subagent_started", "subagent_completed"])

    def test_coding_subagent_runs_in_worktree_and_reports_changes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _init_repo(root)

            def runner(request):
                self.assertFalse(request.readonly)
                self.assertNotEqual(request.cwd.resolve(), root.resolve())
                (request.cwd / "agent.txt").write_text("hello from subagent\n", encoding="utf-8")
                return SubagentOutput(summary="created agent file", validation_result="manual validation")

            result = AgentManager(root, runner=runner).run_coding(
                "Create an agent file",
                worktree="agent-file",
            )

        self.assertEqual(result.agent_type, AgentType.CODING)
        self.assertEqual(result.worktree, "agent-file")
        self.assertIn("agent.txt", result.changed_files)
        self.assertIn("+hello from subagent", result.diff)
        self.assertEqual(result.validation_result, "manual validation")
        self.assertFalse((root / "agent.txt").exists())


if __name__ == "__main__":
    unittest.main()
