from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from tokendance.storage.atomic import atomic_write_text
from tokendance.storage.jsonl import append_jsonl
from tokendance.storage.paths import resolve_project_dir
from tokendance.tasks import TaskService

_WORKTREE_NAME_RE = re.compile(r"[A-Za-z0-9._-]{1,64}")


@dataclass(frozen=True)
class WorktreeRecord:
    name: str
    path: Path
    branch: str
    task_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "path": str(self.path),
            "branch": self.branch,
            "task_id": self.task_id,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "WorktreeRecord":
        return cls(
            name=str(data["name"]),
            path=Path(str(data["path"])),
            branch=str(data["branch"]),
            task_id=str(data["task_id"]) if data.get("task_id") else None,
        )


@dataclass(frozen=True)
class WorktreeRemoveResult:
    name: str
    removed: bool
    message: str


class WorktreeService:
    def __init__(self, repo_root: Path) -> None:
        self.repo_root = Path(repo_root)
        self.state_dir = resolve_project_dir(self.repo_root) / "worktrees"
        self.index_path = self.state_dir / "worktrees.json"
        self.events_path = self.state_dir / "events.jsonl"
        self.worktree_root = self.repo_root.parent / f".tokendance-worktrees-{_safe_directory_name(self.repo_root.name)}"
        self._ensure_project_state_ignored()

    def create(self, name: str, *, task_id: str | None = None) -> WorktreeRecord:
        safe_name = validate_worktree_name(name)
        records = self._load_records()
        if safe_name in records and records[safe_name].path.exists():
            return records[safe_name]

        path = self.worktree_root / safe_name
        branch = f"wt/{safe_name}"
        path.parent.mkdir(parents=True, exist_ok=True)
        self._git("worktree", "add", str(path), "-b", branch, "HEAD")

        record = WorktreeRecord(name=safe_name, path=path, branch=branch, task_id=task_id)
        records[safe_name] = record
        self._write_records(records)
        if task_id:
            TaskService(self.repo_root).link_worktree(task_id, safe_name)
        self._log_event("create", record)
        return record

    def list(self) -> list[WorktreeRecord]:
        return sorted(self._load_records().values(), key=lambda item: item.name)

    def keep(self, name: str) -> WorktreeRemoveResult:
        safe_name = validate_worktree_name(name)
        record = self._require_record(safe_name)
        self._log_event("keep", record)
        return WorktreeRemoveResult(
            name=safe_name,
            removed=False,
            message=f"Worktree '{safe_name}' kept for review at {record.path}.",
        )

    def remove(self, name: str, *, discard_changes: bool = False) -> WorktreeRemoveResult:
        safe_name = validate_worktree_name(name)
        record = self._require_record(safe_name)
        if record.path.exists() and not discard_changes:
            status = self._git_in_worktree(record.path, "status", "--short")
            if status.strip():
                return WorktreeRemoveResult(
                    name=safe_name,
                    removed=False,
                    message=(
                        f"Worktree '{safe_name}' has uncommitted changes; "
                        "pass discard_changes=True to remove it."
                    ),
                )

        if record.path.exists():
            args = ["worktree", "remove", str(record.path)]
            if discard_changes:
                args.append("--force")
            self._git(*args)
        self._delete_branch(record.branch)
        records = self._load_records()
        records.pop(safe_name, None)
        self._write_records(records)
        self._log_event("remove", record)
        return WorktreeRemoveResult(name=safe_name, removed=True, message=f"Worktree '{safe_name}' removed.")

    def _load_records(self) -> dict[str, WorktreeRecord]:
        if not self.index_path.exists():
            return {}
        raw = json.loads(self.index_path.read_text(encoding="utf-8"))
        return {
            name: WorktreeRecord.from_dict(record)
            for name, record in raw.get("worktrees", {}).items()
        }

    def _write_records(self, records: dict[str, WorktreeRecord]) -> None:
        data = {
            "version": 1,
            "updated_at": _utc_now(),
            "worktrees": {
                name: record.to_dict()
                for name, record in sorted(records.items())
            },
        }
        atomic_write_text(
            self.index_path,
            json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        )

    def _require_record(self, name: str) -> WorktreeRecord:
        records = self._load_records()
        try:
            record = records[name]
        except KeyError:
            raise KeyError(f"Worktree not found: {name}") from None
        self._validate_record(record)
        return record

    def _validate_record(self, record: WorktreeRecord) -> None:
        root = self.worktree_root.resolve()
        path = record.path.resolve()
        try:
            path.relative_to(root)
        except ValueError:
            raise ValueError(f"Worktree path is outside managed worktree root: {record.path}") from None
        expected_branch = f"wt/{record.name}"
        if record.branch != expected_branch:
            raise ValueError(f"Worktree branch mismatch for {record.name}: {record.branch}")

    def _log_event(self, event_type: str, record: WorktreeRecord) -> None:
        append_jsonl(
            self.events_path,
            {
                "type": event_type,
                "worktree": record.name,
                "branch": record.branch,
                "path": str(record.path),
                "task_id": record.task_id,
                "timestamp": _utc_now(),
            },
        )

    def _delete_branch(self, branch: str) -> None:
        subprocess.run(
            ["git", "branch", "-D", branch],
            cwd=self.repo_root,
            capture_output=True,
            text=True,
        )

    def _git(self, *args: str) -> str:
        completed = subprocess.run(
            ["git", *args],
            cwd=self.repo_root,
            capture_output=True,
            text=True,
        )
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.strip() or completed.stdout.strip())
        return completed.stdout

    def _ensure_project_state_ignored(self) -> None:
        try:
            exclude_path = self.repo_root / self._git("rev-parse", "--git-path", "info/exclude").strip()
        except RuntimeError:
            return
        exclude_path.parent.mkdir(parents=True, exist_ok=True)
        existing = exclude_path.read_text(encoding="utf-8") if exclude_path.exists() else ""
        entries = {line.strip() for line in existing.splitlines()}
        if ".tokendance/" in entries or "/.tokendance/" in entries:
            return
        with exclude_path.open("a", encoding="utf-8", newline="\n") as file:
            if existing and not existing.endswith(("\n", "\r")):
                file.write("\n")
            file.write(".tokendance/\n")

    @staticmethod
    def _git_in_worktree(path: Path, *args: str) -> str:
        completed = subprocess.run(
            ["git", *args],
            cwd=path,
            capture_output=True,
            text=True,
        )
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.strip() or completed.stdout.strip())
        return completed.stdout


def validate_worktree_name(name: str) -> str:
    normalized = str(name).strip()
    if normalized in {"", ".", ".."} or _WORKTREE_NAME_RE.fullmatch(normalized) is None:
        raise ValueError(
            "Invalid worktree name. Use 1-64 letters, numbers, dots, underscores, or hyphens."
        )
    return normalized


def _safe_directory_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", name.strip()) or "repo"


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")
