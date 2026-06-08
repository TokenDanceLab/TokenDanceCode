import io
import tempfile
import unittest
from pathlib import Path

from tokendance.cli.shell import InteractiveShell, _prepare_output_stream
from tokendance.models.mock import MockProvider
from tokendance.models.types import ModelEvent, TDToolCall
from tokendance.storage.jsonl import read_jsonl


class InteractiveShellTests(unittest.TestCase):
    def test_prepare_output_stream_uses_utf8_when_supported(self) -> None:
        class ReconfigurableStream(io.StringIO):
            def __init__(self) -> None:
                super().__init__()
                self.reconfigure_calls = []

            def reconfigure(self, **kwargs):
                self.reconfigure_calls.append(kwargs)

        stream = ReconfigurableStream()

        _prepare_output_stream(stream)

        self.assertEqual(stream.reconfigure_calls, [{"encoding": "utf-8", "errors": "replace"}])

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

    def test_shell_static_ui_matches_original_unicode_banner(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = io.StringIO()
            shell = InteractiveShell(
                project_root=Path(tmp),
                input_stream=io.StringIO("/exit\n"),
                output_stream=output,
                session_id="session-test",
            )

            shell.run()

        rendered = output.getvalue()
        self.assertIn("\u2500" * 95, rendered)
        self.assertIn("\u2500" * 72, rendered)
        self.assertIn("\u2588" * 8 + "\u2557  " + "\u2588" * 6 + "\u2557", rendered)
        self.assertIn("\u255a\u2550\u2550\u2588\u2588\u2554\u2550\u2550\u255d", rendered)
        self.assertIn("TokenDance Code v0.1.0   Model:", rendered)
        self.assertIn("   CWD: ", rendered)
        self.assertIn("\u276f ", rendered)

    def test_normal_input_renders_tool_events(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "notes.txt").write_text("note body", encoding="utf-8")
            output = io.StringIO()
            provider = MockProvider(
                responses=[
                    [ModelEvent.tool_call(TDToolCall("call-1", "read_file", {"path": "notes.txt"}))],
                    [ModelEvent.text_delta("done"), ModelEvent.message_done()],
                ]
            )
            shell = InteractiveShell(
                project_root=root,
                input_stream=io.StringIO("read notes\n/exit\n"),
                output_stream=output,
                session_id="session-test",
                provider=provider,
            )

            shell.run()

        rendered = output.getvalue()
        self.assertIn("Tool:", rendered)
        self.assertIn("read_file", rendered)
        self.assertIn("done", rendered)

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
