from __future__ import annotations

import os
from pathlib import Path

_ENV_KEYS = {
    "anthropic": "ANTHROPIC_API_KEY",
}

_BASE_URL_KEYS = {
    "anthropic": "ANTHROPIC_BASE_URL",
}

_GLOBAL_LOADED = False
_PROJECT_LOADED: set[str] = set()


def _load_env_file(env_path: Path) -> None:
    """Read KEY=VALUE lines from *env_path* into os.environ (only when key not already set)."""
    if not env_path.exists():
        return
    try:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if "=" not in stripped:
                continue
            key, _, value = stripped.partition("=")
            key = key.strip()
            value = value.strip().strip("\"'")
            if key and value and key not in os.environ:
                os.environ[key] = value
    except OSError:
        pass


def load_project_env(project_root: str | Path) -> None:
    """Load ``<project>/.tokendance/.env`` once per project root."""
    global _PROJECT_LOADED
    root_key = str(Path(project_root).resolve())
    if root_key in _PROJECT_LOADED:
        return
    _PROJECT_LOADED.add(root_key)
    _load_env_file(Path(project_root) / ".env")


def _load_global_env() -> None:
    """Load ``~/.tokendance/.env`` once per process."""
    global _GLOBAL_LOADED
    if _GLOBAL_LOADED:
        return
    _GLOBAL_LOADED = True
    _load_env_file(Path.home() / ".tokendance" / ".env")


def get_env_api_key(provider: str) -> str | None:
    _load_global_env()
    env_name = _ENV_KEYS.get(provider)
    if env_name is None:
        return None
    return os.environ.get(env_name)


def get_env_base_url(provider: str) -> str | None:
    _load_global_env()
    env_name = _BASE_URL_KEYS.get(provider)
    if env_name is None:
        return None
    return os.environ.get(env_name)
