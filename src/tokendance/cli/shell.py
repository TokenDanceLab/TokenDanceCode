from __future__ import annotations

import sys
from pathlib import Path
from typing import TextIO

from rich.console import Console

from tokendance.cli.commands import CommandContext, CommandRouter
from tokendance.cli.renderer import Renderer
from tokendance.core.events import RuntimeEvent
from tokendance.core.session import SessionState
from tokendance.storage.transcript import SessionStore, TranscriptWriter


class InteractiveShell:
    def __init__(
        self,
        *,
        project_root: Path | None = None,
        input_stream: TextIO | None = None,
        output_stream: TextIO | None = None,
        session_id: str | None = None,
    ) -> None:
        self.project_root = Path.cwd() if project_root is None else Path(project_root)
        self.input_stream = sys.stdin if input_stream is None else input_stream
        self.output_stream = sys.stdout if output_stream is None else output_stream
        self.session_id = session_id

        self.console = Console(file=self.output_stream, force_terminal=False, color_system=None)
        self.renderer = Renderer(self.console)
        self.router = CommandRouter()

    def run(self) -> int:
        state = SessionState.new(project_path=self.project_root, session_id=self.session_id)
        paths = SessionStore(self.project_root).create_session(state)
        writer = TranscriptWriter(paths.transcript_path)
        context = CommandContext(
            session_id=state.session_id,
            provider=state.provider,
            model=state.model,
            permission_mode=state.permission_mode,
            mode=state.mode,
            project_path=state.project_path,
        )

        for raw_line in self.input_stream:
            line = raw_line.strip()
            if not line:
                continue
            if line.startswith("/"):
                result = self.router.handle(line, context)
                if result.clear_requested:
                    self.console.clear()
                elif result.message:
                    self.console.print(result.message)
                if result.exit_requested:
                    writer.append(RuntimeEvent(type="turn_completed", payload={"reason": "exit"}))
                    return 0
                continue

            user_event = RuntimeEvent(type="user_message", payload={"content": line})
            writer.append(user_event)
            self.renderer.render(user_event)

            assistant_event = RuntimeEvent(
                type="assistant_done",
                payload={"content": f"You said: {line}"},
            )
            writer.append(assistant_event)
            self.renderer.render(assistant_event)

        return 0
