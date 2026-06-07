from __future__ import annotations

import json
import re
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any

from tokendance.agents.base import AgentRunResult, AgentType, SubagentOutput, SubagentRequest
from tokendance.git.worktree import WorktreeRecord, WorktreeService
from tokendance.storage.atomic import atomic_write_text
from tokendance.storage.jsonl import append_jsonl
from tokendance.storage.paths import resolve_project_dir

SubagentRunner = Callable[[SubagentRequest], SubagentOutput]


class AgentManager:
    def __init__(
        self,
        project_root: Path,
        *,
        runner: SubagentRunner | None = None,
        worktree_service: WorktreeService | None = None,
    ) -> None:
        self.project_root = Path(project_root)
        self.runner = runner or _default_runner
        self.worktree_service = worktree_service or WorktreeService(self.project_root)
        self.state_dir = resolve_project_dir(self.project_root) / "agents"
        self.index_path = self.state_dir / "agents.json"

    def run_readonly(
        self,
        prompt: str,
        *,
        agent_type: AgentType | str = AgentType.INVESTIGATOR,
    ) -> AgentRunResult:
        parsed_type = _parse_agent_type(agent_type)
        if parsed_type == AgentType.CODING:
            raise ValueError("Use run_coding for coding subagents.")
        return self._run(prompt, agent_type=parsed_type, cwd=self.project_root, readonly=True)

    def run_coding(
        self,
        prompt: str,
        *,
        worktree: str | None = None,
        task_id: str | None = None,
    ) -> AgentRunResult:
        agent_id = self._next_agent_id()
        worktree_name = worktree or _slug(f"{agent_id}-{prompt}")
        record = self.worktree_service.create(worktree_name, task_id=task_id)
        return self._run(
            prompt,
            agent_type=AgentType.CODING,
            cwd=record.path,
            readonly=False,
            agent_id=agent_id,
            worktree_record=record,
            task_id=task_id,
        )

    def list(self) -> list[AgentRunResult]:
        if not self.index_path.exists():
            return []
        raw = json.loads(self.index_path.read_text(encoding="utf-8"))
        return [
            AgentRunResult.from_dict(item)
            for item in raw.get("agents", [])
        ]

    def _run(
        self,
        prompt: str,
        *,
        agent_type: AgentType,
        cwd: Path,
        readonly: bool,
        agent_id: str | None = None,
        worktree_record: WorktreeRecord | None = None,
        task_id: str | None = None,
    ) -> AgentRunResult:
        normalized_prompt = _required_text(prompt, "prompt")
        active_agent_id = agent_id or self._next_agent_id()
        transcript_path = self.state_dir / active_agent_id / "transcript.jsonl"
        request = SubagentRequest(
            agent_id=active_agent_id,
            agent_type=agent_type,
            prompt=normalized_prompt,
            cwd=Path(cwd),
            transcript_path=transcript_path,
            readonly=readonly,
            worktree=worktree_record.name if worktree_record else None,
            task_id=task_id,
        )
        self._record_event(
            transcript_path,
            "subagent_started",
            {
                "agent_id": active_agent_id,
                "agent_type": agent_type.value,
                "prompt": normalized_prompt,
                "cwd": str(cwd),
                "readonly": readonly,
                "worktree": request.worktree,
                "task_id": task_id,
            },
        )
        output = self.runner(request)
        changed_files, diff = _collect_changes(Path(cwd)) if not readonly else ([], "")
        result = AgentRunResult(
            agent_id=active_agent_id,
            agent_type=agent_type,
            summary=output.summary or f"{agent_type.value} subagent completed: {normalized_prompt}",
            changed_files=output.changed_files or changed_files,
            diff=output.diff or diff,
            validation_result=output.validation_result,
            transcript_path=transcript_path,
            worktree=worktree_record.name if worktree_record else None,
            worktree_path=worktree_record.path if worktree_record else None,
        )
        self._record_event(transcript_path, "subagent_completed", result.to_dict())
        self._append_result(result)
        return result

    def _next_agent_id(self) -> str:
        numbers = [
            int(match.group(1))
            for result in self.list()
            if (match := re.fullmatch(r"agent-(\d+)", result.agent_id)) is not None
        ]
        return f"agent-{(max(numbers, default=0) + 1):04d}"

    @staticmethod
    def _record_event(path: Path, event_type: str, payload: dict[str, Any]) -> None:
        append_jsonl(path, {"type": event_type, "payload": payload})

    def _append_result(self, result: AgentRunResult) -> None:
        results = [*self.list(), result]
        data = {"version": 1, "agents": [item.to_dict() for item in results]}
        atomic_write_text(
            self.index_path,
            json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        )


def _default_runner(request: SubagentRequest) -> SubagentOutput:
    if request.readonly:
        return SubagentOutput(summary=f"{request.agent_type.value} subagent completed: {request.prompt}")
    return SubagentOutput(
        summary=f"coding subagent prepared worktree {request.worktree}: {request.prompt}",
        validation_result="not run",
    )


def _collect_changes(cwd: Path) -> tuple[list[str], str]:
    status = _git(cwd, "status", "--short")
    changed_files = _parse_status_files(status)
    diff = _git(cwd, "diff")
    untracked = [file for file in changed_files if (cwd / file).exists() and _is_untracked(status, file)]
    if untracked:
        parts = [diff] if diff.strip() else []
        parts.extend(_untracked_diff(cwd, file) for file in untracked)
        diff = "\n".join(part for part in parts if part)
    return changed_files, diff


def _parse_status_files(status: str) -> list[str]:
    files: list[str] = []
    for line in status.splitlines():
        if not line.strip():
            continue
        path = line[3:].strip()
        if " -> " in path:
            path = path.rsplit(" -> ", 1)[-1]
        files.append(path)
    return files


def _is_untracked(status: str, file: str) -> bool:
    return any(line.startswith("?? ") and line[3:].strip() == file for line in status.splitlines())


def _untracked_diff(cwd: Path, file: str) -> str:
    content = (cwd / file).read_text(encoding="utf-8")
    lines = content.splitlines()
    body = "\n".join(f"+{line}" for line in lines)
    return "\n".join(
        [
            f"diff --git a/{file} b/{file}",
            "new file mode 100644",
            "--- /dev/null",
            f"+++ b/{file}",
            f"@@ -0,0 +1,{len(lines)} @@",
            body,
        ]
    )


def _git(cwd: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip())
    return completed.stdout


def _parse_agent_type(value: AgentType | str) -> AgentType:
    if isinstance(value, AgentType):
        return value
    try:
        return AgentType(str(value))
    except ValueError:
        raise ValueError(f"Unknown subagent type: {value}") from None


def _required_text(value: str, label: str) -> str:
    text = str(value).strip()
    if not text:
        raise ValueError(f"{label} is required.")
    return text


def _slug(text: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", text.lower()).strip("-._")
    return (slug or "subagent")[:48]
