from __future__ import annotations

from pathlib import Path

from tokendance.core.session import SessionState
from tokendance.core.turn import TurnResult, TurnRunner
from tokendance.models.base import ModelProvider
from tokendance.models.mock import MockProvider
from tokendance.models.types import ModelEvent
from tokendance.storage.transcript import SessionStore, TranscriptWriter
from tokendance.tools.file import build_file_tool_specs
from tokendance.tools.patch import build_patch_tool_specs
from tokendance.tools.registry import ToolRegistry
from tokendance.tools.shell import build_shell_tool_specs
from tokendance.tools.subagent import build_subagent_tool_specs
from tokendance.tools.task import build_task_tool_specs
from tokendance.tools.todo import build_todo_tool_specs


class CoreRuntime:
    def __init__(
        self,
        *,
        project_root: Path,
        provider: ModelProvider | None = None,
        session_id: str | None = None,
    ) -> None:
        self.project_root = Path(project_root)
        self.provider = provider
        self.state = SessionState.new(project_path=self.project_root, session_id=session_id)
        self.paths = SessionStore(self.project_root).create_session(self.state)
        self.transcript_writer = TranscriptWriter(self.paths.transcript_path)
        self.registry = _default_registry()

    def run_turn(self, user_message: str) -> TurnResult:
        provider = self.provider or MockProvider(
            responses=[[ModelEvent.text_delta(f"You said: {user_message}"), ModelEvent.message_done("end_turn")]]
        )
        return TurnRunner(provider=provider, registry=self.registry).run_turn(
            user_message,
            state=self.state,
            transcript_writer=self.transcript_writer,
        )


def _default_registry() -> ToolRegistry:
    registry = ToolRegistry()
    for spec in [
        *build_file_tool_specs(),
        *build_patch_tool_specs(),
        *build_shell_tool_specs(),
        *build_task_tool_specs(),
        *build_todo_tool_specs(),
        *build_subagent_tool_specs(),
    ]:
        registry.register(spec)
    return registry
