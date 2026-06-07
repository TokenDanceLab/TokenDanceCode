import io
import tempfile
import unittest
from pathlib import Path

from tokendance.cli.shell import InteractiveShell
from tokendance.storage.jsonl import read_jsonl


class InteractiveShellTests(unittest.TestCase):
    def test_run_records_user_message_mock_response_and_exit_event(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = io.StringIO()
            shell = InteractiveShell(
                project_root=Path(tmp),
                input_stream=io.StringIO("hello\n/exit\n"),
                output_stream=output,
                session_id="session-test",
            )

            exit_code = shell.run()

            transcript = read_jsonl(
                Path(tmp) / ".tokendance" / "sessions" / "session-test" / "transcript.jsonl"
            )

        self.assertEqual(exit_code, 0)
        self.assertIn("You said: hello", output.getvalue())
        self.assertEqual([record["type"] for record in transcript], ["user_message", "assistant_done", "turn_completed"])
        self.assertEqual(transcript[-1]["payload"]["reason"], "exit")

    def test_slash_command_does_not_emit_mock_assistant_response(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = io.StringIO()
            shell = InteractiveShell(
                project_root=Path(tmp),
                input_stream=io.StringIO("/status\n/exit\n"),
                output_stream=output,
                session_id="session-test",
            )

            shell.run()

            transcript = read_jsonl(
                Path(tmp) / ".tokendance" / "sessions" / "session-test" / "transcript.jsonl"
            )

        self.assertIn("Session:", output.getvalue())
        self.assertNotIn("You said:", output.getvalue())
        self.assertEqual([record["type"] for record in transcript], ["turn_completed"])
