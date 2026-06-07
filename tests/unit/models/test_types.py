import unittest

from tokendance.models.types import (
    ModelEvent,
    TDContentBlock,
    TDMessage,
    TDToolCall,
    TDToolResult,
    TDToolSpec,
)


class ModelTypesTests(unittest.TestCase):
    def test_message_and_tool_types_are_provider_neutral_records(self) -> None:
        message = TDMessage.user_text("read the repo")
        tool = TDToolSpec(
            name="read_file",
            description="Read a UTF-8 file",
            input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
        )
        call = TDToolCall(id="call-1", name="read_file", arguments={"path": "README.md"})
        result = TDToolResult(tool_call_id="call-1", content="ok")

        self.assertEqual(message.role, "user")
        self.assertEqual(message.content, [TDContentBlock(type="text", text="read the repo")])
        self.assertEqual(tool.name, "read_file")
        self.assertEqual(call.arguments["path"], "README.md")
        self.assertFalse(result.is_error)

    def test_model_event_builders_describe_streaming_events(self) -> None:
        delta = ModelEvent.text_delta("hello")
        tool_call = TDToolCall(id="call-1", name="glob", arguments={"pattern": "*.py"})
        call_event = ModelEvent.tool_call(tool_call)
        done = ModelEvent.message_done(stop_reason="end_turn")

        self.assertEqual(delta.type, "text_delta")
        self.assertEqual(delta.text, "hello")
        self.assertEqual(call_event.tool_call, tool_call)
        self.assertEqual(done.stop_reason, "end_turn")
