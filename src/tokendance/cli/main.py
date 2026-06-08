from __future__ import annotations

import os
from pathlib import Path
from typing import Annotated, Optional

import typer
from rich.console import Console

from tokendance import __version__
from tokendance.cli.commands import build_doctor_text
from tokendance.cli.shell import InteractiveShell
from tokendance.config.loader import load_config
from tokendance.config.secrets import get_env_api_key, load_project_env
from tokendance.context.resume import ResumeService
from tokendance.models.anthropic_provider import AnthropicProvider
from tokendance.models.base import ModelProvider
from tokendance.storage.paths import resolve_global_dir

console = Console()


def _create_provider(project_root: Path) -> ModelProvider | None:
    """Auto-create a real provider when an API key is available.

    Loads project ``.env``, then checks which providers have a key.
    Prefers the configured provider; falls back to the other if only
    one has a key.  Returns ``None`` (MockProvider) when no key is found.
    """
    project_root = Path.cwd()
    load_project_env(project_root)

    global_config_path = resolve_global_dir() / "config.toml"
    config = load_config(global_config_path=global_config_path)

    api_key = get_env_api_key("anthropic")
    if not api_key:
        return None

    model: str = config.model
    env_model = os.environ.get("MODEL_ID", "").strip()
    if env_model and model == "claude-sonnet-4-6":
        model = env_model

    return AnthropicProvider(model=model)


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
    project_root = Path.cwd()
    provider = _create_provider(project_root)
    exit_code = InteractiveShell(project_root=project_root, provider=provider).run()
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
