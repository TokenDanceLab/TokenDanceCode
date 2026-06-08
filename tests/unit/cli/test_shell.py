import io
import tempfile
import unittest
from pathlib import Path

from tokendance.cli.shell import InteractiveShell
from tokendance.models.mock import MockProvider
from tokendance.models.types import ModelEvent
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
        self.assertEqual(
            [record["type"] for record in transcript],
            ["user_message", "assistant_delta", "assistant_done", "turn_completed"],
        )
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

    def test_normal_input_uses_runtime_provider(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = io.StringIO()
            provider = MockProvider(
                responses=[[ModelEvent.text_delta("runtime response"), ModelEvent.message_done()]]
            )
            shell = InteractiveShell(
                project_root=Path(tmp),
                input_stream=io.StringIO("hello\n/exit\n"),
                output_stream=output,
                session_id="session-test",
                provider=provider,
            )

            shell.run()

        self.assertIn("runtime response", output.getvalue())
        self.assertNotIn("You said: hello", output.getvalue())

    def test_shell_saves_session_on_keyboard_interrupt(self) -> None:
        class InterruptingInput:
            def __iter__(self):
                return self

            def __next__(self):
                raise KeyboardInterrupt

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            output = io.StringIO()

            exit_code = InteractiveShell(
                project_root=root,
                input_stream=InterruptingInput(),
                output_stream=output,
                session_id="session-test",
            ).run()
            transcript = read_jsonl(
                root / ".tokendance" / "sessions" / "session-test" / "transcript.jsonl"
            )

        self.assertEqual(exit_code, 130)
        self.assertIn("Interrupted", output.getvalue())
        self.assertEqual(transcript[-1]["type"], "turn_completed")
        self.assertEqual(transcript[-1]["payload"]["reason"], "interrupt")
