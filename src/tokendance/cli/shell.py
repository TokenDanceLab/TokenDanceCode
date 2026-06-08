from __future__ import annotations

import sys
from pathlib import Path
from typing import TextIO

from rich.console import Console
from rich.text import Text

from tokendance import __version__
from tokendance.cli.commands import CommandContext, CommandRouter
from tokendance.cli.renderer import Renderer
from tokendance.core.events import RuntimeEvent
from tokendance.core.interrupts import InterruptHandler
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
        self._sep = "─" * 72

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
            session_dir=runtime.paths.session_dir,
            transcript_path=runtime.paths.transcript_path,
        )

        def save_interrupt() -> None:
            writer.append(RuntimeEvent(type="turn_completed", payload={"reason": "interrupt"}))

        status = InterruptHandler(save_callback=save_interrupt).run(
            lambda: self._run_loop(runtime, context, writer)
        )
        if status.state == "interrupted":
            self.console.print(status.message)
            return 130
        return status.result or 0

    def _run_loop(self, runtime: CoreRuntime, context: CommandContext, writer) -> int:
        self._render_banner(runtime, context)

        # Print the first input frame
        self.console.print(self._sep, style="dim")
        self.console.print("❯ ", end="")

        for raw_line in self.input_stream:
            # ── close input frame ──
            self.console.print(self._sep, style="dim")

            line = raw_line.strip()
            if not line:
                # re-open frame for next input
                self.console.print(self._sep, style="dim")
                self.console.print("❯ ", end="")
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
                # re-open frame for next input
                self.console.print(self._sep, style="dim")
                self.console.print("❯ ", end="")
                continue

            self.console.print()  # blank line before response
            result = runtime.run_turn(line, on_text_delta=lambda text: self.renderer.render(
                RuntimeEvent(type="assistant_delta", payload={"text": text})
            ))
            if result.final_text:
                self.console.print()  # newline after streaming
                self.console.print()  # blank line after response

            # re-open frame for next input
            self.console.print(self._sep, style="dim")
            self.console.print("❯ ", end="")

        return 0

    def _render_banner(self, runtime: CoreRuntime, context: CommandContext) -> None:
        model_name = context.model
        if self.provider is not None:
            model_name = getattr(self.provider, "model", model_name)

        cwd = str(context.project_path)
        sep = "─" * 99

        self.console.print()
        self.console.print(sep, style="bold cyan")

        # ANSI Shadow figlet font — TOKENDANCE
        ansi = {
            "T": ["████████╗", "╚══██╔══╝", "   ██║   ", "   ██║   ", "   ██║   ", "   ╚═╝   "],
            "O": [" ██████╗ ", "██╔═══██╗", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
            "K": ["██╗  ██╗", "██║ ██╔╝", "█████╔╝ ", "██╔═██╗ ", "██║  ██╗", "╚═╝  ╚═╝"],
            "E": ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
            "N": ["███╗   ██╗", "████╗  ██║", "██╔██╗ ██║", "██║╚██╗██║", "██║ ╚████║", "╚═╝  ╚═══╝"],
            "D": ["██████╗ ", "██╔══██╗", "██║  ██║", "██║  ██║", "██████╔╝", "╚═════╝ "],
            "A": [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
            "C": [" ██████╗", "██╔════╝", "██║     ", "██║     ", "╚██████╗", " ╚═════╝"],
        }

        for row in range(6):
            line = "  " + " ".join(ansi[ch][row] for ch in "TOKENDANCE")
            self.console.print(line, style="bold cyan")

        self.console.print()
        self.console.print(f"  TokenDance Code v{__version__}   Model: {model_name}   CWD: {cwd}", style="dim")
        self.console.print(sep, style="bold cyan")
        self.console.print()
