from __future__ import annotations

from rich.console import Console

from tokendance.core.events import RuntimeEvent


class Renderer:
    def __init__(self, console: Console) -> None:
        self.console = console
        self._line_open = False

    def render(self, event: RuntimeEvent) -> None:
        if event.type == "user_message":
            self._print_line(f"User: {event.payload.get('content', '')}")
            return
        if event.type == "assistant_delta":
            text = str(event.payload.get("text", ""))
            self.console.print(text, end="")
            self._line_open = bool(text) and not text.endswith("\n")
            return
        if event.type == "assistant_done":
            self._print_line(f"Assistant: {event.payload.get('content', '')}")
            return
        if event.type.startswith("tool_call_"):
            self._print_line(_format_tool_event(event))
            return
        if event.type == "permission_decision":
            tool = event.payload.get("tool", "")
            behavior = event.payload.get("behavior", "")
            reason = event.payload.get("reason", "")
            suffix = f" - {reason}" if reason else ""
            self._print_line(f"Permission: {tool} {behavior}{suffix}")
            return
        if event.type == "context_compacted":
            self._print_line("Context compacted.")
            return
        if event.type == "error":
            self._print_line(f"Error: {event.payload.get('message', event.payload)}")
            return
        if event.type == "turn_completed":
            return
        self._print_line(str(event.payload))

    def _print_line(self, text: str) -> None:
        if self._line_open:
            self.console.print()
            self._line_open = False
        self.console.print(text)


def _format_tool_event(event: RuntimeEvent) -> str:
    tool = event.payload.get("tool", "")
    if event.type == "tool_call_started":
        arguments = event.payload.get("arguments", {})
        return f"Tool: {tool} start {_summarize_value(arguments)}"
    status = event.payload.get("status", "")
    content = str(event.payload.get("content", ""))
    artifact = f" artifact={event.artifact_ref}" if event.artifact_ref else ""
    if content:
        return f"Tool: {tool} {status} (content {len(content)} chars){artifact}"
    return f"Tool: {tool} {status}{artifact}"


def _summarize_value(value: object) -> str:
    if isinstance(value, str):
        if len(value) > 120 or "\n" in value:
            return f"<{len(value)} chars>"
        return repr(value)
    if isinstance(value, dict):
        items = ", ".join(f"{key!r}: {_summarize_value(item)}" for key, item in value.items())
        return "{" + items + "}"
    if isinstance(value, list):
        if len(value) > 8:
            return f"<list {len(value)} items>"
        return "[" + ", ".join(_summarize_value(item) for item in value) + "]"
    return repr(value)
