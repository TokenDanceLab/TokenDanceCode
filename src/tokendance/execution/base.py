from __future__ import annotations

from pathlib import Path
from typing import Protocol

from tokendance.execution.result import CommandResult


class Executor(Protocol):
    def run(
        self,
        command: str,
        *,
        cwd: Path,
        timeout: float,
        env: dict[str, str] | None = None,
        stdin: str | None = None,
    ) -> CommandResult:
        """Run a command and return a structured result."""
