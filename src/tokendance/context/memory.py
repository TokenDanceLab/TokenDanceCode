from __future__ import annotations

from pathlib import Path

from tokendance.storage.atomic import atomic_write_text
from tokendance.storage.paths import resolve_global_dir, resolve_project_dir


class MemoryStore:
    def __init__(self, *, project_root: Path, home: Path | None = None) -> None:
        self.project_root = Path(project_root)
        self.home = Path.home() if home is None else Path(home)

    def add_project_memory(self, text: str) -> None:
        self._append(self._project_memory_path(), text)

    def list_project_memory(self) -> list[str]:
        return self._read_entries(self._project_memory_path())

    def delete_project_memory(self, index: int) -> None:
        self._delete(self._project_memory_path(), index)

    def add_global_memory(self, text: str) -> None:
        self._append(self._global_memory_path(), text)

    def list_global_memory(self) -> list[str]:
        return self._read_entries(self._global_memory_path())

    def _project_memory_path(self) -> Path:
        return resolve_project_dir(self.project_root) / "memory" / "project.md"

    def _global_memory_path(self) -> Path:
        return resolve_global_dir(self.home) / "memory" / "global.md"

    def _append(self, path: Path, text: str) -> None:
        entries = self._read_entries(path)
        entries.append(text)
        self._write_entries(path, entries)

    def _delete(self, path: Path, index: int) -> None:
        entries = self._read_entries(path)
        if 0 <= index < len(entries):
            del entries[index]
        self._write_entries(path, entries)

    def _read_entries(self, path: Path) -> list[str]:
        if not path.exists():
            return []
        entries: list[str] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped.startswith("- "):
                entries.append(stripped[2:])
        return entries

    def _write_entries(self, path: Path, entries: list[str]) -> None:
        content = "".join(f"- {entry}\n" for entry in entries)
        atomic_write_text(path, content)
