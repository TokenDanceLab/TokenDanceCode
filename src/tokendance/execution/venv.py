from __future__ import annotations

from pathlib import Path


def find_project_venv(project_root: Path) -> Path | None:
    root = Path(project_root)
    candidates = [
        root / ".venv" / "Scripts" / "python.exe",
        root / ".venv" / "bin" / "python",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None
