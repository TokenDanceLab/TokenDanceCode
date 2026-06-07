from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Protocol

from tokendance.models.types import ModelEvent, TDMessage, TDToolSpec


class ModelProvider(Protocol):
    def stream_response(
        self,
        *,
        messages: Sequence[TDMessage],
        tools: Sequence[TDToolSpec],
    ) -> Iterable[ModelEvent]:
        """Yield provider-neutral model events for one model request."""
