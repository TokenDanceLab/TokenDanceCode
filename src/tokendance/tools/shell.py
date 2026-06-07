from __future__ import annotations

from tokendance.tools.spec import ToolContext, ToolResult, ToolSpec


def run_powershell_placeholder(context: ToolContext, arguments: dict) -> ToolResult:
    return ToolResult.error("PowerShell execution is implemented in stage 8.")


def build_shell_tool_specs() -> list[ToolSpec]:
    return [
        ToolSpec(
            "run_powershell",
            "Run a PowerShell command. Placeholder until execution layer is implemented.",
            {"type": "object"},
            "shell",
            run_powershell_placeholder,
        )
    ]
