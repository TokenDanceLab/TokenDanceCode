from __future__ import annotations

from pathlib import Path

from tokendance.execution.local import LocalExecutor
from tokendance.execution.result import CommandResult

QualityResult = CommandResult


class QualityGate:
    def __init__(self, workspace_root: Path) -> None:
        self.workspace_root = Path(workspace_root)

    def run(self, command: str, timeout: float = 120) -> QualityResult:
        return LocalExecutor(workspace_root=self.workspace_root).run(
            command,
            cwd=self.workspace_root,
            timeout=timeout,
        )
