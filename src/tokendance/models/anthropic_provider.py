from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Any

from anthropic import Anthropic

from tokendance.config.secrets import get_env_api_key, get_env_base_url
from tokendance.models.errors import AuthFailed, normalize_provider_error
from tokendance.models.types import ModelEvent, TDMessage, TDToolCall, TDToolSpec


class AnthropicProvider:
    def __init__(
        self,
        *,
        model: str,
        api_key: str | None = None,
        base_url: str | None = None,
        max_tokens: int = 4096,
        client: Any | None = None,
    ) -> None:
        self.model = model
        self.api_key = api_key if api_key is not None else get_env_api_key("anthropic")
        self.base_url = base_url if base_url is not None else get_env_base_url("anthropic")
        self.max_tokens = max_tokens
        self.client = client

    def stream_response(
        self,
        *,
        messages: Sequence[TDMessage],
        tools: Sequence[TDToolSpec],
    ) -> Iterable[ModelEvent]:
        if not self.api_key and self.client is None:
            raise AuthFailed("ANTHROPIC_API_KEY is not configured.")

        client = self.client or Anthropic(api_key=self.api_key, base_url=self.base_url)
        kwargs: dict[str, Any] = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "messages": self.to_anthropic_messages(messages),
            "stream": True,
        }
        system = self.to_anthropic_system(messages)
        if system:
            kwargs["system"] = system
        mapped_tools = self.to_anthropic_tools(tools)
        if mapped_tools:
            kwargs["tools"] = mapped_tools

        try:
            for raw_event in client.messages.create(**kwargs):
                event = self.to_model_event(raw_event)
                if event is not None:
                    yield event
        except Exception as exc:
            raise normalize_provider_error(exc) from exc

    def to_anthropic_messages(self, messages: Sequence[TDMessage]) -> list[dict[str, Any]]:
        mapped: list[dict[str, Any]] = []
        for message in messages:
            if message.role == "system":
                continue
            content: list[dict[str, Any]] = []
            for block in message.content:
                if block.type == "text":
                    content.append({"type": "text", "text": block.text or ""})
                elif block.type == "tool_result":
                    content.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": block.tool_call_id or "",
                            "content": block.tool_result or "",
                        }
                    )
            mapped.append({"role": message.role, "content": content})
        return mapped

    def to_anthropic_system(self, messages: Sequence[TDMessage]) -> str | None:
        parts: list[str] = []
        for message in messages:
            if message.role != "system":
                continue
            for block in message.content:
                if block.type == "text" and block.text:
                    parts.append(block.text)
        return "\n".join(parts) if parts else None

    def to_anthropic_tools(self, tools: Sequence[TDToolSpec]) -> list[dict[str, Any]]:
        return [
            {
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.input_schema,
            }
            for tool in tools
        ]

    def to_model_event(self, raw_event: Any) -> ModelEvent | None:
        event_type = _get(raw_event, "type")
        if event_type == "content_block_delta":
            delta = _get(raw_event, "delta") or {}
            if _get(delta, "type") == "text_delta":
                return ModelEvent.text_delta(str(_get(delta, "text") or ""))
        if event_type == "content_block_start":
            block = _get(raw_event, "content_block") or {}
            if _get(block, "type") == "tool_use":
                return ModelEvent.tool_call(
                    TDToolCall(
                        id=str(_get(block, "id") or ""),
                        name=str(_get(block, "name") or ""),
                        arguments=_get(block, "input") or {},
                    )
                )
        if event_type == "message_stop":
            return ModelEvent.message_done(stop_reason="message_stop")
        return None


def _get(value: Any, key: str) -> Any:
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)
