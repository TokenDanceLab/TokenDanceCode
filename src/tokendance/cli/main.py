from __future__ import annotations

import os
import platform
import sys
from pathlib import Path
from typing import Annotated, Optional

import typer
from rich.console import Console

from tokendance import __version__

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
    console.print("Tokendance interactive shell is not implemented yet.")


@app.command()
def doctor() -> None:
    """Show basic local environment diagnostics."""
    shell = (
        os.environ.get("SHELL")
        or os.environ.get("ComSpec")
        or ("PowerShell" if os.environ.get("PSModulePath") else "unknown")
    )

    console.print(f"Python: {sys.version.split()[0]}")
    console.print(f"OS: {platform.platform()}")
    console.print(f"Shell: {shell}")
    console.print(f"CWD: {Path.cwd()}")


if __name__ == "__main__":
    app()
