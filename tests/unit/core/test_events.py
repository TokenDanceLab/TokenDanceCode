import unittest

from tokendance.core.events import RuntimeEvent


class RuntimeEventTests(unittest.TestCase):
    def test_event_serializes_type_payload_and_artifact_reference(self) -> None:
        event = RuntimeEvent(
            type="tool_call_completed",
            payload={"tool": "read_file", "path": r"C:\repo\中文.py"},
            artifact_ref="tool-outputs/output-0001.txt",
        )

        self.assertEqual(
            event.to_record(),
            {
                "type": "tool_call_completed",
                "payload": {"tool": "read_file", "path": r"C:\repo\中文.py"},
                "artifact_ref": "tool-outputs/output-0001.txt",
            },
        )

    def test_event_requires_known_type(self) -> None:
        with self.assertRaisesRegex(ValueError, "unknown_event"):
            RuntimeEvent(type="unknown_event", payload={})
