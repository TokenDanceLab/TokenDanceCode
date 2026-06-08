from __future__ import annotations

import json
from collections.abc import Iterable, Sequence
from typing import Any

from openai import OpenAI

from tokendance.config.secrets import get_env_api_key, get_env_base_url
from tokendance.models.errors import AuthFailed, normalize_provider_error
from tokendance.models.types import ModelEvent, TDMessage, TDToolCall, TDToolSpec


class OpenAIProvider:
    def __init__(
        self,
        *,
        model: str,
        api_key: str | None = None,
        base_url: str | None = None,
        client: Any | None = None,
    ) -> None:
        self.model = model
        self.api_key = api_key if api_key is not None else get_env_api_key("openai")
        self.base_url = base_url if base_url is not None else get_env_base_url("openai")
        self.client = client

    def stream_response(
        self,
        *,
        messages: Sequence[TDMessage],
        tools: Sequence[TDToolSpec],
    ) -> Iterable[ModelEvent]:
        if not self.api_key and self.client is None:
            raise AuthFailed("OPENAI_API_KEY is not configured.")

        client = self.client or OpenAI(api_key=self.api_key, base_url=self.base_url)
        kwargs: dict[str, Any] = {
            "model": self.model,
            "input": self.to_openai_input(messages),
            "stream": True,
        }
        mapped_tools = self.to_openai_tools(tools)
        if mapped_tools:
            kwargs["tools"] = mapped_tools

        try:
            for raw_event in client.responses.create(**kwargs):
                event = self.to_model_event(raw_event)
                if event is not None:
                    yield event
        except Exception as exc:
            raise normalize_provider_error(exc) from exc

    def to_openai_input(self, messages: Sequence[TDMessage]) -> list[dict[str, Any]]:
        mapped: list[dict[str, Any]] = []
        for message in messages:
            content: list[dict[str, Any]] = []
            for block in message.content:
                if block.type == "text":
                    content.append({"type": _openai_text_type(message.role), "text": block.text or ""})
                elif block.type == "tool_result":
                    mapped.append(
                        {
                            "type": "function_call_output",
                            "call_id": block.tool_call_id or "",
                            "output": block.tool_result or "",
                        }
                    )
            if content:
                mapped.append({"role": message.role, "content": content})
        return mapped

    def to_openai_tools(self, tools: Sequence[TDToolSpec]) -> list[dict[str, Any]]:
        return [
            {
                "type": "function",
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.input_schema,
            }
            for tool in tools
        ]

    def to_model_event(self, raw_event: Any) -> ModelEvent | None:
        event_type = _get(raw_event, "type")
        if event_type == "response.output_text.delta":
            return ModelEvent.text_delta(str(_get(raw_event, "delta") or ""))
        if event_type == "response.completed":
            return ModelEvent.message_done(stop_reason="completed")
        if event_type == "response.output_item.done":
            item = _get(raw_event, "item") or {}
            if _get(item, "type") == "function_call":
                return ModelEvent.tool_call(
                    TDToolCall(
                        id=str(_get(item, "call_id") or _get(item, "id") or ""),
                        name=str(_get(item, "name") or ""),
                        arguments=_parse_arguments(_get(item, "arguments")),
                    )
                )
        return None


def _openai_text_type(role: str) -> str:
    return "input_text" if role in {"user", "system", "tool"} else "output_text"


def _parse_arguments(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    try:
        loaded = json.loads(str(value))
    except json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _get(value: Any, key: str) -> Any:
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)
