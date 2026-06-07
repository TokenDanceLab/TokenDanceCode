from __future__ import annotations

import os
import platform
import sys
from dataclasses import dataclass
from pathlib import Path

from tokendance.config import TokendanceConfig


@dataclass
class CommandContext:
    session_id: str
    provider: str = "openai"
    model: str = "gpt-5.4"
    permission_mode: str = "default"
    mode: str = "work"
    project_path: Path = Path.cwd()


@dataclass(frozen=True)
class CommandResult:
    message: str
    exit_requested: bool = False
    clear_requested: bool = False


class CommandRouter:
    def handle(self, line: str, context: CommandContext) -> CommandResult:
        command, argument = _split_command(line)
        if command == "/help":
            return CommandResult(_help_text())
        if command == "/status":
            return CommandResult(_status_text(context))
        if command == "/clear":
            return CommandResult("", clear_requested=True)
        if command == "/exit":
            return CommandResult("Exit requested. Session saved.", exit_requested=True)
        if command == "/mode":
            return _set_mode(argument, context)
        if command == "/permissions":
            return _set_permissions(argument, context)
        if command == "/config":
            return CommandResult(_config_text(context))
        if command == "/doctor":
            return CommandResult(build_doctor_text())
        return CommandResult(f"Unknown slash command: {command}")


def _split_command(line: str) -> tuple[str, str]:
    stripped = line.strip()
    command, _, argument = stripped.partition(" ")
    return command, argument.strip()


def _help_text() -> str:
    return "\n".join(
        [
            "Available commands:",
            "/help",
            "/status",
            "/clear",
            "/exit",
            "/mode work|teach",
            "/permissions default|safe|auto|yolo",
            "/config",
            "/doctor",
        ]
    )


def _status_text(context: CommandContext) -> str:
    return "\n".join(
        [
            f"Session: {context.session_id}",
            f"Mode: {context.mode}",
            f"Permissions: {context.permission_mode}",
            f"Provider: {context.provider}",
            f"Model: {context.model}",
        ]
    )


def _set_mode(argument: str, context: CommandContext) -> CommandResult:
    if not argument:
        return CommandResult(f"Current mode: {context.mode}")
    if argument not in {"work", "teach"}:
        return CommandResult("Usage: /mode work|teach")
    context.mode = argument
    return CommandResult(f"Mode switched to {context.mode}.")


def _set_permissions(argument: str, context: CommandContext) -> CommandResult:
    if not argument:
        return CommandResult(f"Current permission mode: {context.permission_mode}")
    if argument not in {"default", "safe", "auto", "yolo"}:
        return CommandResult("Usage: /permissions default|safe|auto|yolo")
    context.permission_mode = argument
    return CommandResult(f"Permission mode switched to {context.permission_mode}.")


def _config_text(context: CommandContext) -> str:
    config = TokendanceConfig(
        provider=context.provider,
        model=context.model,
        permission_mode=context.permission_mode,
    )
    return "\n".join(
        [
            f"provider = {config.provider}",
            f"model = {config.model}",
            f"permission_mode = {config.permission_mode}",
            f"executor_backend = {config.executor_backend}",
            f"project_state = {config.project_state}",
        ]
    )


def build_doctor_text() -> str:
    shell = (
        os.environ.get("SHELL")
        or os.environ.get("ComSpec")
        or ("PowerShell" if os.environ.get("PSModulePath") else "unknown")
    )
    return "\n".join(
        [
            f"Python: {sys.version.split()[0]}",
            f"OS: {platform.platform()}",
            f"Shell: {shell}",
            f"CWD: {Path.cwd()}",
        ]
    )
