from __future__ import annotations

import re
from typing import Literal

PowerShellRiskLevel = Literal["safe", "ask", "deny"]

_COMMAND_SEPARATOR = r"(?:^|[\s;&|])"
_COMMAND_END = r"(?=$|[\s;&|])"
_CHAIN_PATTERN = re.compile(r"[;&|]")

_DENY_PATTERNS = [
    re.compile(rf"{_COMMAND_SEPARATOR}(?:Remove-Item|rm|del|erase){_COMMAND_END}", re.IGNORECASE),
    re.compile(rf"{_COMMAND_SEPARATOR}Set-ExecutionPolicy{_COMMAND_END}", re.IGNORECASE),
    re.compile(rf"{_COMMAND_SEPARATOR}Stop-Process{_COMMAND_END}", re.IGNORECASE),
    re.compile(rf"{_COMMAND_SEPARATOR}Restart-Computer{_COMMAND_END}", re.IGNORECASE),
    re.compile(
        r"\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b.*\|.*\b(?:iex|Invoke-Expression)\b",
        re.IGNORECASE,
    ),
    re.compile(r"\bgit\s+reset\b(?=.*(?:--hard|-hard)\b)", re.IGNORECASE),
    re.compile(r"\bgit\s+clean\b(?=.*-[a-z]*f[a-z]*)(?=.*-[a-z]*d[a-z]*)(?=.*-[a-z]*x[a-z]*)", re.IGNORECASE),
]

_SAFE_PATTERNS = [
    re.compile(rf"{_COMMAND_SEPARATOR}(?:Get-ChildItem|gci|ls|dir){_COMMAND_END}", re.IGNORECASE),
    re.compile(rf"{_COMMAND_SEPARATOR}(?:Get-Content|gc|cat|type){_COMMAND_END}", re.IGNORECASE),
    re.compile(rf"{_COMMAND_SEPARATOR}(?:Get-Location|pwd){_COMMAND_END}", re.IGNORECASE),
    re.compile(r"\bgit\s+(?:status|diff|log|branch|show)\b", re.IGNORECASE),
]


def classify_powershell_command(command: str) -> PowerShellRiskLevel:
    stripped = command.strip()
    if not stripped:
        return "safe"

    if any(pattern.search(stripped) for pattern in _DENY_PATTERNS):
        return "deny"

    if _CHAIN_PATTERN.search(stripped):
        return "ask"

    if any(pattern.search(stripped) for pattern in _SAFE_PATTERNS):
        return "safe"

    return "ask"
