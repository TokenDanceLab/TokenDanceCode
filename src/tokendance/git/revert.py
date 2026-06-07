from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from tokendance.storage.atomic import atomic_write_text


@dataclass(frozen=True)
class RevertResult:
    reverted: bool
    message: str


class RevertService:
    def __init__(self, workspace_root: Path) -> None:
        self.workspace_root = Path(workspace_root).resolve()

    def revert_patch_artifact(self, patch_path: Path) -> RevertResult:
        parsed = _parse_simple_patch(Path(patch_path).read_text(encoding="utf-8"))
        if parsed is None:
            return RevertResult(False, "Unsupported patch artifact.")
        relative_path, old_text, new_text = parsed
        target = (self.workspace_root / relative_path).resolve()
        try:
            target.relative_to(self.workspace_root)
        except ValueError:
            return RevertResult(False, "Patch target is outside workspace.")
        content = target.read_text(encoding="utf-8")
        if new_text not in content:
            return RevertResult(False, "Patched text was not found.")
        atomic_write_text(target, content.replace(new_text, old_text, 1))
        return RevertResult(True, f"Reverted {relative_path}.")


def _parse_simple_patch(patch: str) -> tuple[str, str, str] | None:
    target: str | None = None
    old_lines: list[str] = []
    new_lines: list[str] = []
    for line in patch.splitlines():
        if line.startswith("*** Update File: "):
            target = line.removeprefix("*** Update File: ").strip()
        elif line.startswith("-") and not line.startswith("---"):
            old_lines.append(line[1:])
        elif line.startswith("+") and not line.startswith("+++"):
            new_lines.append(line[1:])
    if target is None or not old_lines:
        return None
    return target, "\n".join(old_lines), "\n".join(new_lines)
