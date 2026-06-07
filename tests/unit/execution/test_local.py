import tempfile
import unittest
from pathlib import Path

from tokendance.execution.local import LocalExecutor


class LocalExecutorTests(unittest.TestCase):
    def test_runs_powershell_command_in_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "hello.txt").write_text("hello", encoding="utf-8")
            executor = LocalExecutor(workspace_root=root)

            result = executor.run("Get-ChildItem -Name", cwd=root, timeout=5)

        self.assertEqual(result.exit_code, 0)
        self.assertIn("hello.txt", result.stdout_preview)
        self.assertFalse(result.timed_out)

    def test_timeout_terminates_long_command(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            executor = LocalExecutor(workspace_root=root)

            result = executor.run("Start-Sleep -Seconds 5", cwd=root, timeout=0.2)

        self.assertTrue(result.timed_out)
        self.assertNotEqual(result.exit_code, 0)

    def test_large_stdout_is_written_to_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            session_dir = root / ".tokendance" / "sessions" / "session-test"
            executor = LocalExecutor(workspace_root=root, session_dir=session_dir, output_limit=20)

            result = executor.run("'abcdefghijklmnopqrstuvwxyz'", cwd=root, timeout=5)

            artifact = session_dir / result.stdout_artifact
            artifact_exists = artifact.is_file()

        self.assertEqual(result.exit_code, 0)
        self.assertLessEqual(len(result.stdout_preview), 20)
        self.assertTrue(artifact_exists)
