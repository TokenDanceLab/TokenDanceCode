from __future__ import annotations

from typing import Literal, cast

PermissionMode = Literal["default", "safe", "auto", "yolo"]

VALID_PERMISSION_MODES: frozenset[str] = frozenset({"default", "safe", "auto", "yolo"})


def validate_permission_mode(mode: str) -> PermissionMode:
    if mode not in VALID_PERMISSION_MODES:
        raise ValueError(f"Invalid permission mode: {mode}")
    return cast(PermissionMode, mode)

