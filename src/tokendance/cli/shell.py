from __future__ import annotations

import sys
from pathlib import Path
from typing import TextIO

from rich.console import Console

from tokendance.cli.commands import CommandContext, CommandRouter
from tokendance.cli.renderer import Renderer
from tokendance.core.events import RuntimeEvent
from tokendance.core.runtime import CoreRuntime
from tokendance.models.base import ModelProvider


class InteractiveShell:
    def __init__(
        self,
        *,
        project_root: Path | None = None,
        input_stream: TextIO | None = None,
        output_stream: TextIO | None = None,
        session_id: str | None = None,
        provider: ModelProvider | None = None,
    ) -> None:
        self.project_root = Path.cwd() if project_root is None else Path(project_root)
        self.input_stream = sys.stdin if input_stream is None else input_stream
        self.output_stream = sys.stdout if output_stream is None else output_stream
        self.session_id = session_id
        self.provider = provider

        self.console = Console(file=self.output_stream, force_terminal=False, color_system=None)
        self.renderer = Renderer(self.console)
        self.router = CommandRouter()

    def run(self) -> int:
        runtime = CoreRuntime(project_root=self.project_root, provider=self.provider, session_id=self.session_id)
        state = runtime.state
        writer = runtime.transcript_writer
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

            result = runtime.run_turn(line)
            if result.final_text:
                self.renderer.render(RuntimeEvent(type="assistant_done", payload={"content": result.final_text}))

        return 0
