from __future__ import annotations

from pathlib import Path
from typing import Annotated, Optional

import typer
from rich.console import Console

from tokendance import __version__
from tokendance.cli.commands import build_doctor_text
from tokendance.cli.shell import InteractiveShell
from tokendance.context.resume import ResumeService

console = Console()


def _version_callback(value: bool) -> None:
    if value:
        console.print(f"tokendance {__version__}")
        raise typer.Exit()


app = typer.Typer(
    add_completion=False,
    help="Tokendance local coding agent.",
)


@app.callback(invoke_without_command=True)
def main(
    ctx: typer.Context,
    version: Annotated[
        Optional[bool],
        typer.Option(
            "--version",
            callback=_version_callback,
            is_eager=True,
            help="Show the Tokendance version and exit.",
        ),
    ] = None,
) -> None:
    if version:
        return
    if ctx.invoked_subcommand is not None:
        return
    exit_code = InteractiveShell(project_root=Path.cwd()).run()
    raise typer.Exit(code=exit_code)


@app.command()
def doctor() -> None:
    """Show basic local environment diagnostics."""
    console.print(build_doctor_text())


@app.command()
def resume(session_id: str | None = None) -> None:
    """Resume the latest local session metadata."""
    try:
        result = ResumeService(Path.cwd()).latest()
    except FileNotFoundError as exc:
        console.print(str(exc))
        return
    if session_id and result.state.session_id != session_id:
        console.print(f"Session {session_id} was not found.")
        return
    console.print(
        f"Resumed session {result.state.session_id} with {len(result.recent_records)} recent transcript events."
    )


if __name__ == "__main__":
    app()
