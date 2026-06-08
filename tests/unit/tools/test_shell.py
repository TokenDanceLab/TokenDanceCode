import tempfile
import unittest
from pathlib import Path

from tokendance.storage.transcript import TranscriptWriter
from tokendance.tools.orchestrator import ToolOrchestrator
from tokendance.tools.registry import ToolRegistry
from tokendance.tools.shell import build_shell_tool_specs
from tokendance.tools.spec import ToolContext


class ShellToolTests(unittest.TestCase):
    def test_run_powershell_executes_safe_command_and_records_result(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "hello.txt").write_text("hello", encoding="utf-8")
            session_dir = root / ".tokendance" / "sessions" / "session-test"
            transcript_path = session_dir / "transcript.jsonl"
            registry = ToolRegistry()
            for spec in build_shell_tool_specs():
                registry.register(spec)
            context = ToolContext(
                workspace_root=root,
                session_dir=session_dir,
                transcript_writer=TranscriptWriter(transcript_path),
            )

            result = ToolOrchestrator(registry).execute(
                "run_powershell",
                {"command": "Get-ChildItem -Name", "timeout": 5},
                context,
            )
            records = context.transcript_writer.read_all()

        self.assertEqual(result.status, "ok")
        self.assertIn("hello.txt", result.content)
        self.assertEqual(records[-1]["type"], "tool_call_completed")

    def test_run_powershell_dangerous_command_is_denied_before_execution(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            registry = ToolRegistry()
            for spec in build_shell_tool_specs():
                registry.register(spec)

            result = ToolOrchestrator(registry).execute(
                "run_powershell",
                {"command": "git reset --hard"},
                ToolContext(workspace_root=root, permission_mode="yolo"),
            )

        self.assertEqual(result.status, "error")
        self.assertIn("Permission denied", result.content)

    def test_run_powershell_spec_documents_command_arguments(self) -> None:
        spec = build_shell_tool_specs()[0]

        self.assertEqual(spec.input_schema["required"], ["command"])
        self.assertIn("command", spec.input_schema["properties"])
        self.assertIn("timeout", spec.input_schema["properties"])
