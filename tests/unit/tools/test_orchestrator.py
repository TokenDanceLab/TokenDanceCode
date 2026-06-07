import tempfile
import unittest
from pathlib import Path

from tokendance.core.events import RuntimeEvent
from tokendance.storage.transcript import TranscriptWriter
from tokendance.tools.file import build_file_tool_specs
from tokendance.tools.orchestrator import ToolOrchestrator
from tokendance.tools.registry import ToolRegistry
from tokendance.tools.spec import ToolContext


class ToolOrchestratorTests(unittest.TestCase):
    def test_unknown_tool_returns_error_result(self) -> None:
        orchestrator = ToolOrchestrator(ToolRegistry())

        result = orchestrator.execute(
            "missing",
            {},
            ToolContext(workspace_root=Path.cwd()),
        )

        self.assertEqual(result.status, "error")
        self.assertIn("missing", result.content)

    def test_permission_decision_is_written_to_transcript(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            transcript_path = root / "transcript.jsonl"
            context = ToolContext(
                workspace_root=root,
                permission_mode="safe",
                transcript_writer=TranscriptWriter(transcript_path),
            )
            registry = ToolRegistry()
            for spec in build_file_tool_specs():
                registry.register(spec)
            orchestrator = ToolOrchestrator(registry)

            result = orchestrator.execute(
                "write_file",
                {"path": "notes.txt", "content": "hello"},
                context,
            )
            records = context.transcript_writer.read_all()

        self.assertEqual(result.status, "error")
        self.assertEqual(records[0]["type"], "permission_decision")
        self.assertEqual(records[0]["payload"]["behavior"], "ask")

    def test_allowed_tool_executes_and_records_tool_events(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            transcript_path = root / "transcript.jsonl"
            context = ToolContext(
                workspace_root=root,
                permission_mode="default",
                transcript_writer=TranscriptWriter(transcript_path),
            )
            registry = ToolRegistry()
            for spec in build_file_tool_specs():
                registry.register(spec)

            result = ToolOrchestrator(registry).execute(
                "write_file",
                {"path": "notes.txt", "content": "hello"},
                context,
            )
            records = context.transcript_writer.read_all()
            content = (root / "notes.txt").read_text(encoding="utf-8")

        self.assertEqual(result.status, "ok")
        self.assertEqual(content, "hello")
        self.assertEqual(
            [record["type"] for record in records],
            ["permission_decision", "tool_call_started", "tool_call_completed"],
        )
