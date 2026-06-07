from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Any

from tokendance.config.models import TokendanceConfig


def load_config(
    *,
    global_config_path: Path | None = None,
    project_config_path: Path | None = None,
    cli_overrides: dict[str, Any] | None = None,
) -> TokendanceConfig:
    values: dict[str, Any] = {}
    values.update(_read_toml(global_config_path))
    values.update(_read_toml(project_config_path))
    values.update(_drop_none(cli_overrides or {}))
    return TokendanceConfig.from_mapping(values)


def _read_toml(path: Path | None) -> dict[str, Any]:
    if path is None or not path.exists():
        return {}
    with path.open("rb") as file:
        loaded = tomllib.load(file)
    return _drop_none(loaded)


def _drop_none(values: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in values.items() if value is not None}
