import unittest

from tokendance.execution.result import CommandResult


class CommandResultTests(unittest.TestCase):
    def test_command_result_exposes_previews_and_artifacts(self) -> None:
        result = CommandResult(
            command="Get-ChildItem",
            cwd="C:/repo",
            shell="powershell",
            exit_code=0,
            stdout_preview="ok",
            stderr_preview="",
            stdout_artifact="tool-outputs/stdout-0001.txt",
            stderr_artifact=None,
            duration_ms=12,
            timed_out=False,
        )

        self.assertTrue(result.succeeded)
        self.assertEqual(result.stdout_preview, "ok")
        self.assertEqual(result.stdout_artifact, "tool-outputs/stdout-0001.txt")

    def test_nonzero_exit_code_is_not_success(self) -> None:
        result = CommandResult(
            command="bad",
            cwd="C:/repo",
            shell="powershell",
            exit_code=1,
            stdout_preview="",
            stderr_preview="error",
            stdout_artifact=None,
            stderr_artifact=None,
            duration_ms=1,
            timed_out=False,
        )

        self.assertFalse(result.succeeded)
