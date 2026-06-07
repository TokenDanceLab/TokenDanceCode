import unittest

from tokendance.core.context_builder import ContextBuilder
from tokendance.core.session import SessionState


class ContextBuilderTests(unittest.TestCase):
    def test_build_messages_includes_system_prompt_and_user_message(self) -> None:
        state = SessionState.new(project_path="C:/repo", session_id="session-test")

        messages = ContextBuilder().build_messages(state, "hello")

        self.assertEqual(messages[0].role, "system")
        self.assertIn("Tokendance", messages[0].content[0].text)
        self.assertEqual(messages[-1].role, "user")
        self.assertEqual(messages[-1].content[0].text, "hello")
