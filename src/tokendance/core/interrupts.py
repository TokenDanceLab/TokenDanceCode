from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Generic, Literal, TypeVar

T = TypeVar("T")
InterruptState = Literal["completed", "interrupted"]


@dataclass(frozen=True)
class InterruptStatus(Generic[T]):
    state: InterruptState
    message: str
    saved: bool = False
    result: T | None = None
    save_error: str | None = None


class InterruptHandler:
    def __init__(self, save_callback: Callable[[], object]) -> None:
        self.save_callback = save_callback

    def run(self, action: Callable[[], T]) -> InterruptStatus[T]:
        try:
            result = action()
        except KeyboardInterrupt:
            try:
                self.save_callback()
            except Exception as exc:
                return InterruptStatus(
                    state="interrupted",
                    message="Interrupted by user. Saving progress failed.",
                    saved=False,
                    save_error=str(exc),
                )
            return InterruptStatus(
                state="interrupted",
                message="Interrupted by user. Progress was saved.",
                saved=True,
            )
        return InterruptStatus(
            state="completed",
            message="Completed.",
            result=result,
        )
