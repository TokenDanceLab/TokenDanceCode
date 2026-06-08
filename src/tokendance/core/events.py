from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, get_args

EventType = Literal[
    "user_message",
    "assistant_delta",
    "assistant_done",
    "tool_call_started",
    "tool_call_completed",
    "tool_call_failed",
    "permission_decision",
    "context_compacted",
    "recovery_event",
    "error",
    "turn_completed",
]

_KNOWN_EVENT_TYPES = set(get_args(EventType))


@dataclass(frozen=True)
class RuntimeEvent:
    type: EventType
    payload: dict[str, Any]
    artifact_ref: str | None = None

    def __post_init__(self) -> None:
        if self.type not in _KNOWN_EVENT_TYPES:
            raise ValueError(f"Unknown runtime event type: {self.type}")

    def to_record(self) -> dict[str, Any]:
        record: dict[str, Any] = {
            "type": self.type,
            "payload": self.payload,
        }
        if self.artifact_ref is not None:
            record["artifact_ref"] = self.artifact_ref
        return record
