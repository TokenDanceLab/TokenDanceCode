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

    def test_tool_completion_renders_a_short_summary_not_full_content(self) -> None:
        stream = io.StringIO()
        console = Console(file=stream, force_terminal=False, color_system=None)
        renderer = Renderer(console)

        renderer.render(
            RuntimeEvent(
                type="tool_call_completed",
                payload={"tool": "read_file", "status": "ok", "content": "x" * 2000},
            )
        )

        output = stream.getvalue()
        self.assertIn("Tool:", output)
        self.assertIn("read_file", output)
        self.assertIn("ok", output)
        self.assertIn("2000 chars", output)
        self.assertNotIn("x" * 200, output)

    def test_tool_start_renders_a_short_argument_summary_not_full_content(self) -> None:
        stream = io.StringIO()
        console = Console(file=stream, force_terminal=False, color_system=None)
        renderer = Renderer(console)

        renderer.render(
            RuntimeEvent(
                type="tool_call_started",
                payload={"tool": "write_file", "arguments": {"path": "notes.txt", "content": "x" * 2000}},
            )
        )

        output = stream.getvalue()
        self.assertIn("Tool:", output)
        self.assertIn("write_file", output)
        self.assertIn("notes.txt", output)
        self.assertIn("2000 chars", output)
        self.assertNotIn("x" * 200, output)

    def test_runtime_events_begin_on_new_line_after_text_delta(self) -> None:
        stream = io.StringIO()
        console = Console(file=stream, force_terminal=False, color_system=None)
        renderer = Renderer(console)

        renderer.render(RuntimeEvent(type="assistant_delta", payload={"text": "thinking"}))
        renderer.render(
            RuntimeEvent(
                type="permission_decision",
                payload={"tool": "glob", "behavior": "allow", "reason": "Read is inside workspace"},
            )
        )

        output = stream.getvalue()
        self.assertIn("thinking\nPermission:", output)
