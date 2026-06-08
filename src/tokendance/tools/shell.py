from __future__ import annotations

from tokendance.execution.local import LocalExecutor
from tokendance.tools.spec import ToolContext, ToolResult, ToolSpec


def run_powershell(context: ToolContext, arguments: dict) -> ToolResult:
    command = str(arguments.get("command", ""))
    timeout = float(arguments.get("timeout", 60))
    executor = LocalExecutor(workspace_root=context.workspace_root, session_dir=context.session_dir)
    result = executor.run(command, cwd=context.workspace_root, timeout=timeout)
    content = _format_command_result(result)
    artifact_ref = result.stdout_artifact or result.stderr_artifact
    if result.succeeded:
        return ToolResult.ok(content=content, artifact_ref=artifact_ref)
    return ToolResult.error(content)


def build_shell_tool_specs() -> list[ToolSpec]:
    return [
        ToolSpec(
            "run_powershell",
            "Run a PowerShell command in the workspace.",
            _run_powershell_schema(),
            "shell",
            run_powershell,
        )
    ]


def _run_powershell_schema() -> dict:
    return {
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "PowerShell command to run."},
            "timeout": {"type": "number", "description": "Timeout in seconds. Defaults to 60."},
        },
        "required": ["command"],
    }


def _format_command_result(result) -> str:
    parts = [
        f"exit_code: {result.exit_code}",
        f"duration_ms: {result.duration_ms}",
    ]
    if result.timed_out:
        parts.append("timed_out: true")
    if result.stdout_preview:
        parts.append("stdout:")
        parts.append(result.stdout_preview.rstrip())
    if result.stderr_preview:
        parts.append("stderr:")
        parts.append(result.stderr_preview.rstrip())
    return "\n".join(parts)
