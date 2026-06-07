from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from tokendance.models.types import ModelEvent, TDMessage, TDToolSpec


@dataclass(frozen=True)
class MockCall:
    messages: list[TDMessage]
    tools: list[TDToolSpec]


class MockProvider:
    def __init__(self, responses: Sequence[Sequence[ModelEvent]]) -> None:
        self._responses = [list(response) for response in responses]
        self.calls: list[MockCall] = []

    def stream_response(
        self,
        *,
        messages: Sequence[TDMessage],
        tools: Sequence[TDToolSpec],
    ) -> Iterable[ModelEvent]:
        self.calls.append(MockCall(messages=list(messages), tools=list(tools)))
        if self._responses:
            yield from self._responses.pop(0)
            return
        yield ModelEvent.message_done(stop_reason="mock_exhausted")
