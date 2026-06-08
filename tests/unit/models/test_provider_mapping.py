import unittest

from tokendance.models.anthropic_provider import AnthropicProvider
from tokendance.models.errors import AuthFailed
from tokendance.models.openai_provider import OpenAIProvider
from tokendance.models.types import TDContentBlock, TDMessage, TDToolSpec


class ProviderMappingTests(unittest.TestCase):
    def test_openai_maps_messages_and_tools_to_responses_format(self) -> None:
        provider = OpenAIProvider(model="gpt-test", api_key="")
        messages = [TDMessage.user_text("hello")]
        tools = [
            TDToolSpec(
                name="read_file",
                description="Read a file",
                input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
            )
        ]

        self.assertEqual(
            provider.to_openai_input(messages),
            [{"role": "user", "content": [{"type": "input_text", "text": "hello"}]}],
        )
        self.assertEqual(
            provider.to_openai_tools(tools),
            [
                {
                    "type": "function",
                    "name": "read_file",
                    "description": "Read a file",
                    "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
                }
            ],
        )

    def test_openai_maps_streaming_text_and_tool_events(self) -> None:
        provider = OpenAIProvider(model="gpt-test", api_key="")

        text_event = provider.to_model_event({"type": "response.output_text.delta", "delta": "hi"})
        tool_event = provider.to_model_event(
            {
                "type": "response.output_item.done",
                "item": {
                    "type": "function_call",
                    "call_id": "call-1",
                    "name": "read_file",
                    "arguments": '{"path": "README.md"}',
                },
            }
        )

        self.assertEqual(text_event.text, "hi")
        self.assertEqual(tool_event.tool_call.id, "call-1")
        self.assertEqual(tool_event.tool_call.arguments, {"path": "README.md"})

    def test_anthropic_maps_messages_and_tools_to_messages_format(self) -> None:
        provider = AnthropicProvider(model="claude-test", api_key="")
        messages = [TDMessage.user_text("hello")]
        tools = [TDToolSpec(name="read_file", description="Read a file", input_schema={"type": "object"})]

        self.assertEqual(
            provider.to_anthropic_messages(messages),
            [{"role": "user", "content": [{"type": "text", "text": "hello"}]}],
        )
        self.assertEqual(
            provider.to_anthropic_tools(tools),
            [{"name": "read_file", "description": "Read a file", "input_schema": {"type": "object"}}],
        )

    def test_anthropic_maps_tool_use_and_result_to_messages_format(self) -> None:
        provider = AnthropicProvider(model="claude-test", api_key="")
        messages = [
            TDMessage.user_text("read notes"),
            TDMessage(
                role="assistant",
                content=[
                    TDContentBlock(
                        type="tool_use",
                        tool_call_id="call-1",
                        tool_name="read_file",
                        tool_input={"path": "notes.txt"},
                    )
                ],
            ),
            TDMessage(
                role="tool",
                content=[
                    TDContentBlock(
                        type="tool_result",
                        tool_call_id="call-1",
                        tool_result="note body",
                        is_error=True,
                    )
                ],
            ),
        ]

        self.assertEqual(
            provider.to_anthropic_messages(messages),
            [
                {"role": "user", "content": [{"type": "text", "text": "read notes"}]},
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "call-1",
                            "name": "read_file",
                            "input": {"path": "notes.txt"},
                        }
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "call-1",
                            "content": "note body",
                            "is_error": True,
                        }
                    ],
                },
            ],
        )

    def test_anthropic_maps_streaming_text_and_tool_events(self) -> None:
        provider = AnthropicProvider(model="claude-test", api_key="")

        text_event = provider.to_model_event(
            {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "hi"}}
        )
        tool_event = provider.to_model_event(
            {
                "type": "content_block_start",
                "content_block": {
                    "type": "tool_use",
                    "id": "toolu-1",
                    "name": "read_file",
                    "input": {"path": "README.md"},
                },
            }
        )

        self.assertEqual(text_event.text, "hi")
        self.assertEqual(tool_event.tool_call.id, "toolu-1")
        self.assertEqual(tool_event.tool_call.arguments, {"path": "README.md"})

    def test_anthropic_stream_response_accumulates_streamed_tool_input(self) -> None:
        class FakeMessages:
            def create(self, **kwargs):
                yield {
                    "type": "content_block_start",
                    "index": 1,
                    "content_block": {
                        "type": "tool_use",
                        "id": "toolu-1",
                        "name": "read_file",
                        "input": {},
                    },
                }
                yield {
                    "type": "content_block_delta",
                    "index": 1,
                    "delta": {"type": "input_json_delta", "partial_json": '{"path": "'},
                }
                yield {
                    "type": "content_block_delta",
                    "index": 1,
                    "delta": {"type": "input_json_delta", "partial_json": 'README.md"}'},
                }
                yield {"type": "content_block_stop", "index": 1}
                yield {"type": "message_stop"}

        class FakeClient:
            messages = FakeMessages()

        provider = AnthropicProvider(model="claude-test", client=FakeClient())

        events = list(provider.stream_response(messages=[TDMessage.user_text("read")], tools=[]))

        tool_events = [event for event in events if event.type == "tool_call"]
        self.assertEqual(len(tool_events), 1)
        self.assertEqual(tool_events[0].tool_call.id, "toolu-1")
        self.assertEqual(tool_events[0].tool_call.name, "read_file")
        self.assertEqual(tool_events[0].tool_call.arguments, {"path": "README.md"})

    def test_providers_raise_clear_error_without_api_key(self) -> None:
        with self.assertRaises(AuthFailed):
            list(OpenAIProvider(model="gpt-test", api_key="").stream_response(messages=[], tools=[]))

        with self.assertRaises(AuthFailed):
            list(AnthropicProvider(model="claude-test", api_key="").stream_response(messages=[], tools=[]))
