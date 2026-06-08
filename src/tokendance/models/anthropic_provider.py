from __future__ import annotations

import json
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

        pending_tool_uses: dict[int, dict[str, Any]] = {}
        try:
            for raw_event in client.messages.create(**kwargs):
                event = self.to_model_event(raw_event, pending_tool_uses=pending_tool_uses)
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
                elif block.type == "tool_use":
                    content.append(
                        {
                            "type": "tool_use",
                            "id": block.tool_call_id or "",
                            "name": block.tool_name or "",
                            "input": block.tool_input or {},
                        }
                    )
                elif block.type == "tool_result":
                    tool_result: dict[str, Any] = {
                        "type": "tool_result",
                        "tool_use_id": block.tool_call_id or "",
                        "content": block.tool_result or "",
                    }
                    if block.is_error:
                        tool_result["is_error"] = True
                    content.append(tool_result)
            if content:
                mapped.append({"role": _anthropic_role(message.role), "content": content})
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

    def to_model_event(
        self,
        raw_event: Any,
        *,
        pending_tool_uses: dict[int, dict[str, Any]] | None = None,
    ) -> ModelEvent | None:
        event_type = _get(raw_event, "type")
        if event_type == "content_block_delta":
            delta = _get(raw_event, "delta") or {}
            if _get(delta, "type") == "input_json_delta" and pending_tool_uses is not None:
                index = _event_index(raw_event)
                if index in pending_tool_uses:
                    pending_tool_uses[index]["partial_json"] += str(_get(delta, "partial_json") or "")
                return None
            if _get(delta, "type") == "text_delta":
                return ModelEvent.text_delta(str(_get(delta, "text") or ""))
        if event_type == "content_block_start":
            block = _get(raw_event, "content_block") or {}
            if _get(block, "type") == "tool_use":
                if pending_tool_uses is not None:
                    pending_tool_uses[_event_index(raw_event)] = {
                        "id": str(_get(block, "id") or ""),
                        "name": str(_get(block, "name") or ""),
                        "input": _get(block, "input") or {},
                        "partial_json": "",
                    }
                    return None
                return ModelEvent.tool_call(
                    TDToolCall(
                        id=str(_get(block, "id") or ""),
                        name=str(_get(block, "name") or ""),
                        arguments=_get(block, "input") or {},
                    )
                )
        if event_type == "content_block_stop" and pending_tool_uses is not None:
            index = _event_index(raw_event)
            pending = pending_tool_uses.pop(index, None)
            if pending is None:
                return None
            return ModelEvent.tool_call(
                TDToolCall(
                    id=pending["id"],
                    name=pending["name"],
                    arguments=_tool_arguments(pending["input"], pending["partial_json"]),
                )
            )
        if event_type == "message_stop":
            return ModelEvent.message_done(stop_reason="message_stop")
        return None


def _event_index(raw_event: Any) -> int:
    value = _get(raw_event, "index")
    return int(value or 0)


def _tool_arguments(initial_input: Any, partial_json: str) -> dict[str, Any]:
    if partial_json:
        try:
            loaded = json.loads(partial_json)
        except json.JSONDecodeError:
            loaded = {}
        return loaded if isinstance(loaded, dict) else {}
    return initial_input if isinstance(initial_input, dict) else {}


def _get(value: Any, key: str) -> Any:
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _anthropic_role(role: str) -> str:
    return "user" if role == "tool" else role
