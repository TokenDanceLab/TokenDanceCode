from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CommandResult:
    command: str
    cwd: str
    shell: str
    exit_code: int
    stdout_preview: str
    stderr_preview: str
    stdout_artifact: str | None
    stderr_artifact: str | None
    duration_ms: int
    timed_out: bool

    @property
    def succeeded(self) -> bool:
        return self.exit_code == 0 and not self.timed_out
