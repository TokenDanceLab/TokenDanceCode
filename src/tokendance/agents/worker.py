from __future__ import annotations

from tokendance.agents.manager import AgentManager


def run_coding_worker(manager: AgentManager, prompt: str, *, worktree: str | None = None, task_id: str | None = None):
    return manager.run_coding(prompt, worktree=worktree, task_id=task_id)
