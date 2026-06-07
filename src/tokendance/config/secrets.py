from __future__ import annotations

import os

_ENV_KEYS = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
}


def get_env_api_key(provider: str) -> str | None:
    env_name = _ENV_KEYS.get(provider)
    if env_name is None:
        return None
    return os.environ.get(env_name)
