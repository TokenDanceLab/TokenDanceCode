import unittest

from tokendance.models.mock import MockProvider
from tokendance.models.types import ModelEvent, TDMessage, TDToolCall, TDToolSpec


class MockProviderTests(unittest.TestCase):
    def test_streams_a_pure_text_response(self) -> None:
        provider = MockProvider(
            responses=[
                [
                    ModelEvent.text_delta("hello"),
                    ModelEvent.text_delta(" world"),
                    ModelEvent.message_done(stop_reason="end_turn"),
                ]
            ]
        )

        events = list(provider.stream_response(messages=[TDMessage.user_text("hi")], tools=[]))

        self.assertEqual([event.text for event in events if event.type == "text_delta"], ["hello", " world"])
        self.assertEqual(events[-1].type, "message_done")

    def test_streams_a_tool_call_response(self) -> None:
        tool_call = TDToolCall(id="call-1", name="read_file", arguments={"path": "README.md"})
        provider = MockProvider(responses=[[ModelEvent.tool_call(tool_call), ModelEvent.message_done()]])

        events = list(
            provider.stream_response(
                messages=[TDMessage.user_text("read")],
                tools=[TDToolSpec(name="read_file", description="Read file", input_schema={})],
            )
        )

        self.assertEqual(events[0].tool_call, tool_call)

    def test_records_internal_messages_and_tools_for_runtime_tests(self) -> None:
        provider = MockProvider(responses=[[ModelEvent.message_done()]])
        messages = [TDMessage.user_text("hi")]
        tools = [TDToolSpec(name="glob", description="Glob files", input_schema={})]

        list(provider.stream_response(messages=messages, tools=tools))

        self.assertEqual(provider.calls[0].messages, messages)
        self.assertEqual(provider.calls[0].tools, tools)
