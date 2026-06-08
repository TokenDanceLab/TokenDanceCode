from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass

from tokendance.core.context_builder import ContextBuilder
from tokendance.core.events import RuntimeEvent
from tokendance.core.recovery import RecoveryEvent, RecoveryEventKind, RecoveryPolicy
from tokendance.core.session import SessionState
from tokendance.models.base import ModelProvider
from tokendance.models.errors import ContextLengthExceeded, ProviderUnavailable, RateLimited
from tokendance.models.types import ModelEvent, TDContentBlock, TDMessage, TDToolCall, TDToolResult, TDToolSpec
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
        max_model_calls: int = 64,
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
        on_runtime_event: Callable[[RuntimeEvent], None] | None = None,
    ) -> TurnResult:
        messages = self.context_builder.build_messages(state, user_message)
        transcript_writer.append(RuntimeEvent(type="user_message", payload={"content": user_message}))
        tool_results: list[TDToolResult] = []
        final_text_parts: list[str] = []

        for _ in range(self.max_model_calls):
            model_requested_tool = False
            text_parts: list[str] = []
            assistant_blocks: list[TDContentBlock] = []
            pending_tool_results: list[TDToolResult] = []

            for event in self._stream_provider_events(messages, transcript_writer):
                if event.type == "text_delta" and event.text is not None:
                    text_parts.append(event.text)
                    transcript_writer.append(RuntimeEvent(type="assistant_delta", payload={"text": event.text}))
                    if on_text_delta is not None:
                        on_text_delta(event.text)
                elif event.type == "tool_call" and event.tool_call is not None:
                    model_requested_tool = True
                    assistant_blocks.append(_tool_use_block(event.tool_call))
                    result = self.orchestrator.execute(
                        event.tool_call.name,
                        event.tool_call.arguments,
                        ToolContext(
                            workspace_root=state.project_path,
                            permission_mode=state.permission_mode,
                            session_dir=transcript_writer.transcript_path.parent,
                            transcript_writer=transcript_writer,
                            event_callback=on_runtime_event,
                        ),
                    )
                    tool_result = TDToolResult(
                        tool_call_id=event.tool_call.id,
                        content=result.content,
                        is_error=result.status != "ok",
                    )
                    tool_results.append(tool_result)
                    pending_tool_results.append(tool_result)

            if text_parts:
                final_text = "".join(text_parts)
                final_text_parts.append(final_text)
                assistant_blocks.insert(0, TDContentBlock(type="text", text=final_text))
                transcript_writer.append(RuntimeEvent(type="assistant_done", payload={"content": final_text}))

            if assistant_blocks:
                messages.append(TDMessage(role="assistant", content=assistant_blocks))
            if pending_tool_results:
                messages.append(_tool_result_message(pending_tool_results))

            if not model_requested_tool:
                return TurnResult(final_text="".join(final_text_parts), tool_results=tool_results)

        message = f"Stopped after reaching the model-call limit ({self.max_model_calls}) before a final response."
        limit_event = RuntimeEvent(
            type="error",
            payload={"kind": "model_call_limit", "message": message},
        )
        transcript_writer.append(limit_event)
        if on_runtime_event is not None:
            on_runtime_event(limit_event)
        return TurnResult(final_text="".join(final_text_parts), tool_results=tool_results)

    def _tool_specs(self) -> list[TDToolSpec]:
        return [
            TDToolSpec(name=spec.name, description=spec.description, input_schema=spec.input_schema)
            for spec in self.registry.list_tools()
        ]

    def _stream_provider_events(
        self,
        messages: list[TDMessage],
        transcript_writer: TranscriptWriter,
    ) -> Iterator[ModelEvent]:
        policy = RecoveryPolicy()
        attempt = 0
        retries = 0
        compactions = 0

        while True:
            attempt += 1
            emitted = False
            try:
                for event in self.provider.stream_response(
                    messages=messages,
                    tools=self._tool_specs(),
                ):
                    emitted = True
                    yield event
                return
            except (RateLimited, ProviderUnavailable) as exc:
                if emitted:
                    _record_recovery_event(transcript_writer, _recovery_event("give_up", attempt, exc))
                    raise
                if retries < policy.max_retries:
                    retries += 1
                    _record_recovery_event(transcript_writer, _recovery_event("retry", attempt, exc))
                    continue
                _record_recovery_event(transcript_writer, _recovery_event("give_up", attempt, exc))
                raise
            except ContextLengthExceeded as exc:
                if emitted:
                    _record_recovery_event(transcript_writer, _recovery_event("give_up", attempt, exc))
                    raise
                if compactions < policy.max_context_compactions:
                    compactions += 1
                    _record_recovery_event(transcript_writer, _recovery_event("compact", attempt, exc))
                    _compact_messages(messages)
                    continue
                _record_recovery_event(transcript_writer, _recovery_event("give_up", attempt, exc))
                raise


def _tool_use_block(tool_call: TDToolCall) -> TDContentBlock:
    return TDContentBlock(
        type="tool_use",
        tool_call_id=tool_call.id,
        tool_name=tool_call.name,
        tool_input=tool_call.arguments,
    )


def _tool_result_message(results: list[TDToolResult]) -> TDMessage:
    return TDMessage(
        role="tool",
        content=[
            TDContentBlock(
                type="tool_result",
                tool_call_id=result.tool_call_id,
                tool_result=result.content,
                is_error=result.is_error,
            )
            for result in results
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


def _recovery_event(kind: RecoveryEventKind, attempt: int, error: Exception) -> RecoveryEvent:
    return RecoveryEvent(
        kind=kind,
        attempt=attempt,
        error_type=error.__class__.__name__,
        message=str(error),
    )
