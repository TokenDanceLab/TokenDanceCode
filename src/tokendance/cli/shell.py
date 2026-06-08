from __future__ import annotations

import sys
from pathlib import Path
from typing import TextIO

from rich.console import Console

from tokendance import __version__
from tokendance.cli.commands import CommandContext, CommandRouter
from tokendance.cli.renderer import Renderer
from tokendance.core.events import RuntimeEvent
from tokendance.core.interrupts import InterruptHandler
from tokendance.core.runtime import CoreRuntime
from tokendance.models.base import ModelProvider


_BLOCK = "\u2588"
_HORIZONTAL = "\u2550"
_VERTICAL = "\u2551"
_TOP_LEFT = "\u2554"
_TOP_RIGHT = "\u2557"
_BOTTOM_LEFT = "\u255a"
_BOTTOM_RIGHT = "\u255d"
_BANNER_SEPARATOR = "\u2500" * 95
_INPUT_SEPARATOR = "\u2500" * 72
_PROMPT = "\u276f "

_FIGLET = {
    "T": [
        _BLOCK * 8 + _TOP_RIGHT,
        _BOTTOM_LEFT + _HORIZONTAL * 2 + _BLOCK * 2 + _TOP_LEFT + _HORIZONTAL * 2 + _BOTTOM_RIGHT,
        "   " + _BLOCK * 2 + _VERTICAL + "   ",
        "   " + _BLOCK * 2 + _VERTICAL + "   ",
        "   " + _BLOCK * 2 + _VERTICAL + "   ",
        "   " + _BOTTOM_LEFT + _HORIZONTAL + _BOTTOM_RIGHT + "   ",
    ],
    "O": [
        " " + _BLOCK * 6 + _TOP_RIGHT + " ",
        _BLOCK * 2 + _TOP_LEFT + _HORIZONTAL * 3 + _BLOCK * 2 + _TOP_RIGHT,
        _BLOCK * 2 + _VERTICAL + "   " + _BLOCK * 2 + _VERTICAL,
        _BLOCK * 2 + _VERTICAL + "   " + _BLOCK * 2 + _VERTICAL,
        _BOTTOM_LEFT + _BLOCK * 6 + _TOP_LEFT + _BOTTOM_RIGHT,
        " " + _BOTTOM_LEFT + _HORIZONTAL * 5 + _BOTTOM_RIGHT + " ",
    ],
    "K": [
        _BLOCK * 2 + _TOP_RIGHT + "  " + _BLOCK * 2 + _TOP_RIGHT,
        _BLOCK * 2 + _VERTICAL + " " + _BLOCK * 2 + _TOP_LEFT + _BOTTOM_RIGHT,
        _BLOCK * 5 + _TOP_LEFT + _BOTTOM_RIGHT + " ",
        _BLOCK * 2 + _TOP_LEFT + _HORIZONTAL + _BLOCK * 2 + _TOP_RIGHT + " ",
        _BLOCK * 2 + _VERTICAL + "  " + _BLOCK * 2 + _TOP_RIGHT,
        _BOTTOM_LEFT + _HORIZONTAL + _BOTTOM_RIGHT + "  " + _BOTTOM_LEFT + _HORIZONTAL + _BOTTOM_RIGHT,
    ],
    "E": [
        _BLOCK * 7 + _TOP_RIGHT,
        _BLOCK * 2 + _TOP_LEFT + _HORIZONTAL * 4 + _BOTTOM_RIGHT,
        _BLOCK * 5 + _TOP_RIGHT + "  ",
        _BLOCK * 2 + _TOP_LEFT + _HORIZONTAL * 2 + _BOTTOM_RIGHT + "  ",
        _BLOCK * 7 + _TOP_RIGHT,
        _BOTTOM_LEFT + _HORIZONTAL * 6 + _BOTTOM_RIGHT,
    ],
    "N": [
        _BLOCK * 3 + _TOP_RIGHT + "   " + _BLOCK * 2 + _TOP_RIGHT,
        _BLOCK * 4 + _TOP_RIGHT + "  " + _BLOCK * 2 + _VERTICAL,
        _BLOCK * 2 + _TOP_LEFT + _BLOCK * 2 + _TOP_RIGHT + " " + _BLOCK * 2 + _VERTICAL,
        _BLOCK * 2 + _VERTICAL + _BOTTOM_LEFT + _BLOCK * 2 + _TOP_RIGHT + _BLOCK * 2 + _VERTICAL,
        _BLOCK * 2 + _VERTICAL + " " + _BOTTOM_LEFT + _BLOCK * 4 + _VERTICAL,
        _BOTTOM_LEFT + _HORIZONTAL + _BOTTOM_RIGHT + "  " + _BOTTOM_LEFT + _HORIZONTAL * 3 + _BOTTOM_RIGHT,
    ],
    "D": [
        _BLOCK * 6 + _TOP_RIGHT + " ",
        _BLOCK * 2 + _TOP_LEFT + _HORIZONTAL * 2 + _BLOCK * 2 + _TOP_RIGHT,
        _BLOCK * 2 + _VERTICAL + "  " + _BLOCK * 2 + _VERTICAL,
        _BLOCK * 2 + _VERTICAL + "  " + _BLOCK * 2 + _VERTICAL,
        _BLOCK * 6 + _TOP_LEFT + _BOTTOM_RIGHT,
        _BOTTOM_LEFT + _HORIZONTAL * 5 + _BOTTOM_RIGHT + " ",
    ],
    "A": [
        " " + _BLOCK * 5 + _TOP_RIGHT + " ",
        _BLOCK * 2 + _TOP_LEFT + _HORIZONTAL * 2 + _BLOCK * 2 + _TOP_RIGHT,
        _BLOCK * 7 + _VERTICAL,
        _BLOCK * 2 + _TOP_LEFT + _HORIZONTAL * 2 + _BLOCK * 2 + _VERTICAL,
        _BLOCK * 2 + _VERTICAL + "  " + _BLOCK * 2 + _VERTICAL,
        _BOTTOM_LEFT + _HORIZONTAL + _BOTTOM_RIGHT + "  " + _BOTTOM_LEFT + _HORIZONTAL + _BOTTOM_RIGHT,
    ],
    "C": [
        " " + _BLOCK * 6 + _TOP_RIGHT,
        _BLOCK * 2 + _TOP_LEFT + _HORIZONTAL * 4 + _BOTTOM_RIGHT,
        _BLOCK * 2 + _VERTICAL + "     ",
        _BLOCK * 2 + _VERTICAL + "     ",
        _BOTTOM_LEFT + _BLOCK * 6 + _TOP_RIGHT,
        " " + _BOTTOM_LEFT + _HORIZONTAL * 5 + _BOTTOM_RIGHT,
    ],
}
_BANNER_LINES = [
    " ".join(_FIGLET[char][row] for char in "TOKENDANCE")
    for row in range(6)
]


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
        _prepare_output_stream(self.output_stream)
        self.session_id = session_id
        self.provider = provider

        self.console = Console(file=self.output_stream, force_terminal=False, color_system=None, width=120)
        self.renderer = Renderer(self.console)
        self.router = CommandRouter()
        self._sep = _INPUT_SEPARATOR

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
        self._render_banner(context)
        self._open_input_frame()

        for raw_line in self.input_stream:
            self.console.print(self._sep, style="dim")

            line = raw_line.strip()
            if not line:
                self._open_input_frame()
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
                self._open_input_frame()
                continue

            self.console.print()
            result = runtime.run_turn(
                line,
                on_text_delta=lambda text: self.renderer.render(
                    RuntimeEvent(type="assistant_delta", payload={"text": text})
                ),
                on_runtime_event=self.renderer.render,
            )
            if result.final_text:
                self.console.print()
                self.console.print()

            self._open_input_frame()

        return 0

    def _open_input_frame(self) -> None:
        self.console.print(self._sep, style="dim")
        self.console.print(_PROMPT, end="")

    def _render_banner(self, context: CommandContext) -> None:
        model_name = context.model
        if self.provider is not None:
            model_name = getattr(self.provider, "model", model_name)

        cwd = str(context.project_path)
        sep = _BANNER_SEPARATOR

        self.console.print()
        self.console.print(sep, style="bold cyan")
        for line in _BANNER_LINES:
            self.console.print(line, style="bold cyan")
        self.console.print()
        self.console.print(f"TokenDance Code v{__version__}   Model: {model_name}   CWD: {cwd}", style="dim")
        self.console.print(sep, style="bold cyan")
        self.console.print()


def _prepare_output_stream(output_stream: TextIO) -> None:
    reconfigure = getattr(output_stream, "reconfigure", None)
    if reconfigure is None:
        return
    try:
        reconfigure(encoding="utf-8", errors="replace")
    except (OSError, TypeError, ValueError):
        return
