import os
import unittest

from tokendance.models.anthropic_provider import AnthropicProvider
from tokendance.models.openai_provider import OpenAIProvider
from tokendance.models.types import TDMessage


def _integration_enabled(provider: str) -> bool:
    return (
        os.environ.get("TOKENDANCE_RUN_MODEL_INTEGRATION") == "1"
        and bool(os.environ.get(f"{provider}_API_KEY"))
        and bool(os.environ.get(f"TOKENDANCE_{provider}_TEST_MODEL"))
    )


class RealProviderIntegrationTests(unittest.TestCase):
    @unittest.skipUnless(_integration_enabled("OPENAI"), "OpenAI integration test is opt-in.")
    def test_openai_provider_can_request_text_when_configured(self) -> None:
        provider = OpenAIProvider(model=os.environ["TOKENDANCE_OPENAI_TEST_MODEL"])

        events = list(provider.stream_response(messages=[TDMessage.user_text("Reply with: pong")], tools=[]))

        text = "".join(event.text or "" for event in events if event.type == "text_delta")
        self.assertIn("pong", text.lower())

    @unittest.skipUnless(_integration_enabled("ANTHROPIC"), "Anthropic integration test is opt-in.")
    def test_anthropic_provider_can_request_text_when_configured(self) -> None:
        provider = AnthropicProvider(model=os.environ["TOKENDANCE_ANTHROPIC_TEST_MODEL"])

        events = list(provider.stream_response(messages=[TDMessage.user_text("Reply with: pong")], tools=[]))

        text = "".join(event.text or "" for event in events if event.type == "text_delta")
        self.assertIn("pong", text.lower())
