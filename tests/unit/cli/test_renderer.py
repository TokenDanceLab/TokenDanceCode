import io
import unittest

from rich.console import Console

from tokendance.cli.renderer import Renderer
from tokendance.core.events import RuntimeEvent


class RendererTests(unittest.TestCase):
    def test_renders_user_and_assistant_events(self) -> None:
        stream = io.StringIO()
        console = Console(file=stream, force_terminal=False, color_system=None)
        renderer = Renderer(console)

        renderer.render(RuntimeEvent(type="user_message", payload={"content": "hello"}))
        renderer.render(RuntimeEvent(type="assistant_done", payload={"content": "You said: hello"}))

        output = stream.getvalue()
        self.assertIn("User", output)
        self.assertIn("hello", output)
        self.assertIn("Assistant", output)
        self.assertIn("You said: hello", output)
