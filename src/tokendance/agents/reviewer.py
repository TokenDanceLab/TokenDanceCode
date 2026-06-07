from __future__ import annotations

from tokendance.agents.base import AgentType
from tokendance.agents.manager import AgentManager


def run_readonly_reviewer(manager: AgentManager, prompt: str):
    return manager.run_readonly(prompt, agent_type=AgentType.REVIEWER)
