from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class StoragePaths:
    global_dir: Path
    project_dir: Path


def resolve_global_dir(home: Path | None = None) -> Path:
    root = Path.home() if home is None else Path(home)
    storage_dir = root / ".tokendance"
    storage_dir.mkdir(parents=True, exist_ok=True)
    return storage_dir


def resolve_project_dir(project_root: Path) -> Path:
    storage_dir = Path(project_root) / ".tokendance"
    storage_dir.mkdir(parents=True, exist_ok=True)
    return storage_dir


def normalize_path(path: Path) -> str:
    normalized = str(Path(path).resolve())
    if os.name == "nt":
        return normalized.casefold()
    return normalized

