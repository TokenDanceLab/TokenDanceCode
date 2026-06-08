from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from tokendance.core.context_builder import ContextBuilder
from tokendance.core.events import RuntimeEvent
from tokendance.core.recovery import RecoveryEvent, recover_provider_call
from tokendance.core.session import SessionState
from tokendance.models.base import ModelProvider
from tokendance.models.types import ModelEvent, TDContentBlock, TDMessage, TDToolResult, TDToolSpec
from tokendance.storage.transcript import TranscriptWriter
from tokendance.tools.orchestrator import ToolOrchestrator
from tokendance.tools.registry import ToolRegistry
from tokendance.tools.spec import ToolContext


@dataclass(frozen=True)
class TurnResult:
    final_text: str
    tool_results: list[TDToolResult]


class TurnRunner:
    def __init__(
        self,
        *,
        provider: ModelProvider,
        registry: ToolRegistry,
        context_builder: ContextBuilder | None = None,
        orchestrator: ToolOrchestrator | None = None,
        max_model_calls: int = 8,
    ) -> None:
        self.provider = provider
        self.registry = registry
        self.context_builder = context_builder or ContextBuilder()
        self.orchestrator = orchestrator or ToolOrchestrator(registry)
        self.max_model_calls = max_model_calls

    def run_turn(
        self,
        user_message: str,
        *,
        state: SessionState,
        transcript_writer: TranscriptWriter,
        on_text_delta: Callable[[str], None] | None = None,
    ) -> TurnResult:
        messages = self.context_builder.build_messages(state, user_message)
        transcript_writer.append(RuntimeEvent(type="user_message", payload={"content": user_message}))
        tool_results: list[TDToolResult] = []
        final_text_parts: list[str] = []

        for _ in range(self.max_model_calls):
            events = recover_provider_call(
                lambda: list(
                    self.provider.stream_response(
                        messages=messages,
                        tools=self._tool_specs(),
                    )
                ),
                compact_context=lambda: _compact_messages(messages),
                on_recovery_event=lambda event: _record_recovery_event(transcript_writer, event),
            )
            model_requested_tool = False
            text_parts: list[str] = []

            for event in events:
                if event.type == "text_delta" and event.text is not None:
                    text_parts.append(event.text)
                    transcript_writer.append(RuntimeEvent(type="assistant_delta", payload={"text": event.text}))
                    if on_text_delta is not None:
                        on_text_delta(event.text)
                elif event.type == "tool_call" and event.tool_call is not None:
                    model_requested_tool = True
                    result = self.orchestrator.execute(
                        event.tool_call.name,
                        event.tool_call.arguments,
                        ToolContext(
                            workspace_root=state.project_path,
                            permission_mode=state.permission_mode,
                            session_dir=transcript_writer.transcript_path.parent,
                            transcript_writer=transcript_writer,
                        ),
                    )
                    tool_result = TDToolResult(
                        tool_call_id=event.tool_call.id,
                        content=result.content,
                        is_error=result.status != "ok",
                    )
                    tool_results.append(tool_result)
                    messages.append(_tool_result_message(tool_result))

            if text_parts:
                final_text = "".join(text_parts)
                final_text_parts.append(final_text)
                messages.append(TDMessage.assistant_text(final_text))
                transcript_writer.append(RuntimeEvent(type="assistant_done", payload={"content": final_text}))

            if not model_requested_tool:
                return TurnResult(final_text="".join(final_text_parts), tool_results=tool_results)

        return TurnResult(final_text="".join(final_text_parts), tool_results=tool_results)

    def _tool_specs(self) -> list[TDToolSpec]:
        return [
            TDToolSpec(name=spec.name, description=spec.description, input_schema=spec.input_schema)
            for spec in self.registry.list_tools()
        ]


def _tool_result_message(result: TDToolResult) -> TDMessage:
    return TDMessage(
        role="tool",
        content=[
            TDContentBlock(
                type="tool_result",
                tool_call_id=result.tool_call_id,
                tool_result=result.content,
                is_error=result.is_error,
            )
        ],
    )


def _compact_messages(messages: list[TDMessage]) -> None:
    system_messages = [message for message in messages if message.role == "system"][:1]
    user_messages = [message for message in messages if message.role == "user"]
    latest_user = user_messages[-1:] if user_messages else []
    messages[:] = [
        *system_messages,
        TDMessage.user_text("Context was compacted after a provider context-length error. Continue the task."),
        *latest_user,
    ]


def _record_recovery_event(writer: TranscriptWriter, event: RecoveryEvent) -> None:
    writer.append(
        RuntimeEvent(
            type="recovery_event",
            payload={
                "kind": event.kind,
                "attempt": event.attempt,
                "error_type": event.error_type,
                "message": event.message,
            },
        )
    )
