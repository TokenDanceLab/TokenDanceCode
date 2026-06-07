from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal, TypeVar

from tokendance.models.errors import ContextLengthExceeded, ProviderUnavailable, RateLimited

T = TypeVar("T")
RecoveryEventKind = Literal["retry", "compact", "give_up"]


@dataclass(frozen=True)
class RecoveryPolicy:
    max_retries: int = 2
    max_context_compactions: int = 1

    def __post_init__(self) -> None:
        if self.max_retries < 0:
            raise ValueError("max_retries must be non-negative")
        if self.max_context_compactions < 0:
            raise ValueError("max_context_compactions must be non-negative")


@dataclass(frozen=True)
class RecoveryEvent:
    kind: RecoveryEventKind
    attempt: int
    error_type: str
    message: str


def recover_provider_call(
    call_provider: Callable[[], T],
    *,
    policy: RecoveryPolicy | None = None,
    compact_context: Callable[[], object] | None = None,
    on_recovery_event: Callable[[RecoveryEvent], object] | None = None,
) -> T:
    active_policy = policy or RecoveryPolicy()
    attempt = 0
    retries = 0
    compactions = 0

    while True:
        attempt += 1
        try:
            return call_provider()
        except (RateLimited, ProviderUnavailable) as exc:
            if retries < active_policy.max_retries:
                retries += 1
                _emit(on_recovery_event, "retry", attempt, exc)
                continue
            _emit(on_recovery_event, "give_up", attempt, exc)
            raise
        except ContextLengthExceeded as exc:
            if compact_context is not None and compactions < active_policy.max_context_compactions:
                compactions += 1
                _emit(on_recovery_event, "compact", attempt, exc)
                compact_context()
                continue
            _emit(on_recovery_event, "give_up", attempt, exc)
            raise


def build_continuation_prompt(result: object) -> str:
    artifacts = _collect_artifacts(result)
    previews = _collect_previews(result)
    lines = ["Continue from the previous output without repeating completed work."]

    if artifacts:
        lines.append("Output artifact(s): " + ", ".join(artifacts))

    if previews:
        lines.append("Visible output preview:")
        for label, value in previews:
            lines.append(f"{label}:\n{value}")

    if artifacts:
        lines.append("Use the saved artifact when the preview is incomplete.")

    return "\n\n".join(lines)


def _emit(
    on_recovery_event: Callable[[RecoveryEvent], object] | None,
    kind: RecoveryEventKind,
    attempt: int,
    error: Exception,
) -> None:
    if on_recovery_event is None:
        return
    on_recovery_event(
        RecoveryEvent(
            kind=kind,
            attempt=attempt,
            error_type=error.__class__.__name__,
            message=str(error),
        )
    )


def _collect_artifacts(result: object) -> list[str]:
    artifacts = []
    for name in ("artifact_ref", "stdout_artifact", "stderr_artifact"):
        value = getattr(result, name, None)
        if value:
            artifacts.append(str(value))
    return artifacts


def _collect_previews(result: object) -> list[tuple[str, str]]:
    previews = []
    for label, name in (
        ("stdout preview", "stdout_preview"),
        ("stderr preview", "stderr_preview"),
        ("content preview", "content"),
    ):
        value = getattr(result, name, None)
        if value:
            previews.append((label, str(value)))
    return previews
