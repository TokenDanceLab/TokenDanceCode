import tempfile
import unittest
from pathlib import Path

from tokendance.core.runtime import CoreRuntime
from tokendance.models.mock import MockProvider
from tokendance.models.types import ModelEvent, TDToolCall


class MockAgentLoopIntegrationTests(unittest.TestCase):
    def test_runtime_uses_mock_provider_to_read_file_and_answer(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "README.md").write_text("Tokendance notes", encoding="utf-8")
            provider = MockProvider(
                responses=[
                    [ModelEvent.tool_call(TDToolCall("call-1", "read_file", {"path": "README.md"}))],
                    [ModelEvent.text_delta("README says Tokendance notes"), ModelEvent.message_done()],
                ]
            )
            runtime = CoreRuntime(project_root=root, provider=provider, session_id="session-test")

            result = runtime.run_turn("read README")

        self.assertEqual(result.final_text, "README says Tokendance notes")
        self.assertEqual(len(provider.calls), 2)
