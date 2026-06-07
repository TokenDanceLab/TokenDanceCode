from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path

from tokendance.execution.result import CommandResult
from tokendance.storage.atomic import atomic_write_text
from tokendance.storage.paths import normalize_path


class LocalExecutor:
    def __init__(
        self,
        *,
        workspace_root: Path,
        session_dir: Path | None = None,
        output_limit: int = 4000,
        shell_executable: str | None = None,
    ) -> None:
        self.workspace_root = Path(workspace_root).resolve()
        self.session_dir = Path(session_dir) if session_dir is not None else None
        self.output_limit = output_limit
        self.shell_executable = shell_executable or _default_powershell()

    def run(
        self,
        command: str,
        *,
        cwd: Path,
        timeout: float,
        env: dict[str, str] | None = None,
        stdin: str | None = None,
    ) -> CommandResult:
        resolved_cwd = Path(cwd).resolve()
        if not _inside_workspace(resolved_cwd, self.workspace_root):
            raise ValueError("Command cwd is outside the workspace.")

        started = time.perf_counter()
        timed_out = False
        exit_code = 0
        stdout = ""
        stderr = ""
        try:
            completed = subprocess.run(
                [self.shell_executable, "-NoProfile", "-NonInteractive", "-Command", command],
                cwd=str(resolved_cwd),
                input=stdin,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=_merge_env(env),
            )
            exit_code = completed.returncode
            stdout = completed.stdout
            stderr = completed.stderr
        except subprocess.TimeoutExpired as exc:
            timed_out = True
            exit_code = -1
            stdout = _coerce_output(exc.stdout)
            stderr = _coerce_output(exc.stderr) or f"Command timed out after {timeout} seconds."

        duration_ms = int((time.perf_counter() - started) * 1000)
        stdout_preview, stdout_artifact = self._preview_or_artifact(stdout, "stdout")
        stderr_preview, stderr_artifact = self._preview_or_artifact(stderr, "stderr")
        return CommandResult(
            command=command,
            cwd=str(resolved_cwd),
            shell="powershell",
            exit_code=exit_code,
            stdout_preview=stdout_preview,
            stderr_preview=stderr_preview,
            stdout_artifact=stdout_artifact,
            stderr_artifact=stderr_artifact,
            duration_ms=duration_ms,
            timed_out=timed_out,
        )

    def _preview_or_artifact(self, output: str, stream_name: str) -> tuple[str, str | None]:
        if len(output) <= self.output_limit:
            return output, None
        if self.session_dir is None:
            return output[: self.output_limit], None
        output_dir = self.session_dir / "tool-outputs"
        output_dir.mkdir(parents=True, exist_ok=True)
        index = len(list(output_dir.glob(f"{stream_name}-*.txt"))) + 1
        artifact_ref = f"tool-outputs/{stream_name}-{index:04d}.txt"
        atomic_write_text(self.session_dir / artifact_ref, output)
        return output[: self.output_limit], artifact_ref


def _default_powershell() -> str:
    if os.name == "nt":
        return "powershell.exe"
    return "pwsh"


def _merge_env(env: dict[str, str] | None) -> dict[str, str] | None:
    if env is None:
        return None
    merged = os.environ.copy()
    merged.update(env)
    return merged


def _coerce_output(value: str | bytes | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode(errors="replace")
    return value


def _inside_workspace(path: Path, workspace_root: Path) -> bool:
    root_key = normalize_path(workspace_root)
    path_key = normalize_path(path)
    return path_key == root_key or path_key.startswith(root_key + "\\") or path_key.startswith(root_key + "/")
