from __future__ import annotations

from tokendance.core.session import SessionState
from tokendance.models.types import TDMessage


class ContextBuilder:
    def build_messages(self, state: SessionState, user_message: str) -> list[TDMessage]:
        system = TDMessage(
            role="system",
            content=[
                TDMessage.user_text(
                    "Tokendance is a local command-line coding agent. Keep responses concise."
                ).content[0]
            ],
        )
        return [system, TDMessage.user_text(user_message)]
