import unittest
from pathlib import Path
from unittest.mock import patch

from typer.testing import CliRunner

from tokendance.cli.main import app
from tokendance.core.events import RuntimeEvent
from tokendance.core.session import SessionState
from tokendance.storage.transcript import SessionStore, TranscriptWriter


class CliMainTests(unittest.TestCase):
    def test_version_flag_prints_package_version(self) -> None:
        runner = CliRunner()

        result = runner.invoke(app, ["--version"])

        self.assertEqual(result.exit_code, 0)
        self.assertIn("tokendance 0.1.0", result.stdout)

    def test_doctor_reports_environment_basics(self) -> None:
        runner = CliRunner()

        result = runner.invoke(app, ["doctor"])

        self.assertEqual(result.exit_code, 0)
        self.assertIn("Python:", result.stdout)
        self.assertIn("OS:", result.stdout)
        self.assertIn("Shell:", result.stdout)
        self.assertIn("CWD:", result.stdout)

    def test_doctor_does_not_start_interactive_shell(self) -> None:
        runner = CliRunner()

        result = runner.invoke(app, ["doctor"])

        self.assertEqual(result.exit_code, 0)
        self.assertNotIn("interactive shell", result.stdout)

    def test_root_command_runs_interactive_shell(self) -> None:
        runner = CliRunner()

        with runner.isolated_filesystem():
            with patch("tokendance.cli.main._create_provider", return_value=None):
                result = runner.invoke(app, input="hello\n/exit\n")

        self.assertEqual(result.exit_code, 0)
        self.assertIn("You said: hello", result.stdout)

    def test_resume_command_reports_when_no_session_exists(self) -> None:
        runner = CliRunner()

        with runner.isolated_filesystem():
            result = runner.invoke(app, ["resume"])

        self.assertEqual(result.exit_code, 0)
        self.assertIn("no resumable", result.stdout.lower())

    def test_resume_command_loads_latest_session_metadata(self) -> None:
        runner = CliRunner()

        with runner.isolated_filesystem():
            root = Path.cwd()
            state = SessionState.new(project_path=root, session_id="session-test")
            paths = SessionStore(root).create_session(state)
            TranscriptWriter(paths.transcript_path).append(
                RuntimeEvent(type="user_message", payload={"content": "hello"})
            )

            result = runner.invoke(app, ["resume"])

        self.assertEqual(result.exit_code, 0)
        self.assertIn("session-test", result.stdout)
        self.assertIn("1 recent", result.stdout)
