from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class WorktreeInfo:
    path: Path
    branch: str | None = None
    commit: str | None = None


class GitService:
    def __init__(self, repo_root: Path) -> None:
        self.repo_root = Path(repo_root)

    def status_short(self) -> str:
        return self._git("status", "--short")

    def diff(self, *paths: str) -> str:
        args = ["diff", *paths]
        return self._git(*args)

    def log(self, limit: int = 5) -> str:
        return self._git("log", f"-{limit}", "--oneline")

    def current_branch(self) -> str:
        return self._git("branch", "--show-current").strip()

    def worktree_list(self) -> list[WorktreeInfo]:
        output = self._git("worktree", "list", "--porcelain")
        entries: list[WorktreeInfo] = []
        current: dict[str, str] = {}
        for line in output.splitlines():
            if not line:
                if current:
                    entries.append(_worktree_from_record(current))
                    current = {}
                continue
            key, _, value = line.partition(" ")
            current[key] = value
        if current:
            entries.append(_worktree_from_record(current))
        return entries

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


def _worktree_from_record(record: dict[str, str]) -> WorktreeInfo:
    branch = record.get("branch")
    if branch and branch.startswith("refs/heads/"):
        branch = branch.removeprefix("refs/heads/")
    return WorktreeInfo(path=Path(record["worktree"]), branch=branch, commit=record.get("HEAD"))
