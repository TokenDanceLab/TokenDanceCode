from __future__ import annotations

from rich.console import Console

from tokendance.core.events import RuntimeEvent


class Renderer:
    def __init__(self, console: Console) -> None:
        self.console = console

    def render(self, event: RuntimeEvent) -> None:
        if event.type == "user_message":
            self.console.print(f"User: {event.payload.get('content', '')}")
            return
        if event.type == "assistant_delta":
            self.console.print(event.payload.get("text", ""), end="")
            return
        if event.type == "assistant_done":
            self.console.print(f"Assistant: {event.payload.get('content', '')}")
            return
        if event.type.startswith("tool_call_"):
            self.console.print(f"Tool: {event.payload}")
            return
        if event.type == "permission_decision":
            self.console.print(f"Permission: {event.payload}")
            return
        if event.type == "context_compacted":
            self.console.print("Context compacted.")
            return
        if event.type == "error":
            self.console.print(f"Error: {event.payload.get('message', event.payload)}")
            return
        if event.type == "turn_completed":
            return
        self.console.print(str(event.payload))
