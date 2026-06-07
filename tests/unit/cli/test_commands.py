import unittest
import tempfile
from pathlib import Path

from tokendance.cli.commands import CommandContext, CommandRouter
from tokendance.core.events import RuntimeEvent
from tokendance.storage.transcript import TranscriptWriter


class CommandRouterTests(unittest.TestCase):
    def test_help_lists_core_slash_commands(self) -> None:
        router = CommandRouter()
        context = CommandContext(session_id="session-1")

        result = router.handle("/help", context)

        self.assertFalse(result.exit_requested)
        self.assertIn("/status", result.message)
        self.assertIn("/exit", result.message)

    def test_mode_switches_between_work_and_teach(self) -> None:
        router = CommandRouter()
        context = CommandContext(session_id="session-1", mode="work")

        result = router.handle("/mode teach", context)

        self.assertEqual(context.mode, "teach")
        self.assertIn("teach", result.message)

    def test_exit_requests_shell_shutdown(self) -> None:
        router = CommandRouter()
        context = CommandContext(session_id="session-1")

        result = router.handle("/exit", context)

        self.assertTrue(result.exit_requested)
        self.assertIn("exit", result.message.lower())

    def test_memory_add_and_list_project_memory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            context = CommandContext(session_id="session-1", project_path=root, home=root / "home")
            router = CommandRouter()

            add_result = router.handle("/memory add project Use unittest.", context)
            list_result = router.handle("/memory", context)

        self.assertIn("saved", add_result.message.lower())
        self.assertIn("Use unittest.", list_result.message)

    def test_transcript_search_uses_current_transcript(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            transcript = root / "transcript.jsonl"
            TranscriptWriter(transcript).append(RuntimeEvent(type="user_message", payload={"content": "parser"}))
            context = CommandContext(session_id="session-1", project_path=root, transcript_path=transcript)

            result = CommandRouter().handle("/transcript search parser", context)

        self.assertIn("seq=1", result.message)

    def test_compact_writes_summary_for_current_session(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            session_dir = root / ".tokendance" / "sessions" / "session-1"
            transcript = session_dir / "transcript.jsonl"
            TranscriptWriter(transcript).append(RuntimeEvent(type="user_message", payload={"content": "hello"}))
            context = CommandContext(
                session_id="session-1",
                project_path=root,
                session_dir=session_dir,
                transcript_path=transcript,
            )

            result = CommandRouter().handle("/compact", context)

        self.assertIn("compact", result.message.lower())
