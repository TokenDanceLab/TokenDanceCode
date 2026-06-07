from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

MessageRole = Literal["system", "user", "assistant", "tool"]
ContentBlockType = Literal["text", "tool_result"]
ModelEventType = Literal["text_delta", "tool_call", "message_done"]


@dataclass(frozen=True)
class TDContentBlock:
    type: ContentBlockType
    text: str | None = None
    tool_call_id: str | None = None
    tool_result: str | None = None
    is_error: bool = False


@dataclass(frozen=True)
class TDMessage:
    role: MessageRole
    content: list[TDContentBlock]

    @classmethod
    def user_text(cls, text: str) -> "TDMessage":
        return cls(role="user", content=[TDContentBlock(type="text", text=text)])

    @classmethod
    def assistant_text(cls, text: str) -> "TDMessage":
        return cls(role="assistant", content=[TDContentBlock(type="text", text=text)])


@dataclass(frozen=True)
class TDToolSpec:
    name: str
    description: str
    input_schema: dict[str, Any]


@dataclass(frozen=True)
class TDToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class TDToolResult:
    tool_call_id: str
    content: str
    is_error: bool = False


@dataclass(frozen=True)
class ModelEvent:
    type: ModelEventType
    text: str | None = None
    tool_call: TDToolCall | None = None
    stop_reason: str | None = None

    @classmethod
    def text_delta(cls, text: str) -> "ModelEvent":
        return cls(type="text_delta", text=text)

    @classmethod
    def tool_call(cls, tool_call: TDToolCall) -> "ModelEvent":
        return cls(type="tool_call", tool_call=tool_call)

    @classmethod
    def message_done(cls, stop_reason: str | None = None) -> "ModelEvent":
        return cls(type="message_done", stop_reason=stop_reason)


@dataclass(frozen=True)
class TDModelResponse:
    events: list[ModelEvent]
