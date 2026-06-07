from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from tokendance.permissions.modes import PermissionMode, validate_permission_mode
from tokendance.permissions.powershell import PowerShellRiskLevel, classify_powershell_command

PermissionAction = Literal["allow", "ask", "deny"]

_READ_TOOLS = frozenset(
    {
        "read_file",
        "glob",
        "glob_files",
        "list_files",
        "task_get",
        "task_list",
        "todo_list",
        "subagent_list",
        "worktree_list",
    }
)
_WRITE_TOOLS = frozenset(
    {
        "write_file",
        "edit_file",
        "apply_patch",
        "apply_patch_tool",
        "patch",
        "task_create",
        "task_update_status",
        "task_add_dependency",
        "task_link_session",
        "task_link_worktree",
        "todo_write",
        "todo_update",
        "subagent_run",
        "worktree_create",
        "worktree_keep",
        "worktree_remove",
    }
)
_SHELL_TOOLS = frozenset({"run_powershell", "powershell", "shell", "run_shell"})
_PATH_KEYS = frozenset({"path", "file_path", "target_path", "directory", "cwd"})
_PATCH_FILE_PREFIXES = (
    "*** Add File: ",
    "*** Update File: ",
    "*** Delete File: ",
    "*** Move to: ",
)


@dataclass(frozen=True)
class PermissionDecision:
    action: PermissionAction
    reason: str = ""
    risk_level: PowerShellRiskLevel | None = None

    @property
    def behavior(self) -> PermissionAction:
        return self.action


class PermissionEngine:
    def evaluate(
        self,
        tool_name: str,
        arguments: dict[str, Any] | None,
        mode: str,
        workspace_root: str | Path,
    ) -> PermissionDecision:
        permission_mode = validate_permission_mode(mode)
        tool = _normalize_tool_name(tool_name)
        args = arguments or {}
        root = Path(workspace_root).resolve()

        if _is_shell_tool(tool):
            return self._evaluate_shell(args)

        if _is_read_tool(tool):
            return self._evaluate_read(tool, args, root)

        if _is_write_tool(tool):
            return self._evaluate_write(tool, args, permission_mode, root)

        return PermissionDecision("ask", f"Unknown tool requires approval: {tool_name}")

    def _evaluate_shell(self, arguments: dict[str, Any]) -> PermissionDecision:
        command = str(arguments.get("command", ""))
        risk_level = classify_powershell_command(command)
        if risk_level == "safe":
            return PermissionDecision("allow", "PowerShell command classified safe", risk_level)
        return PermissionDecision(risk_level, f"PowerShell command classified {risk_level}", risk_level)

    def _evaluate_read(self, tool: str, arguments: dict[str, Any], workspace_root: Path) -> PermissionDecision:
        if _all_paths_inside_workspace(tool, arguments, workspace_root):
            return PermissionDecision("allow", "Read is inside workspace")
        return PermissionDecision("ask", "Read path is outside workspace")

    def _evaluate_write(
        self,
        tool: str,
        arguments: dict[str, Any],
        mode: PermissionMode,
        workspace_root: Path,
    ) -> PermissionDecision:
        if not _all_paths_inside_workspace(tool, arguments, workspace_root):
            return PermissionDecision("deny", "Write path is outside workspace")
        if mode == "safe":
            return PermissionDecision("ask", "Safe mode asks before writes")
        return PermissionDecision("allow", "Write is inside workspace")


def _normalize_tool_name(tool_name: str) -> str:
    return tool_name.strip().lower().replace("-", "_")


def _is_read_tool(tool: str) -> bool:
    return tool in _READ_TOOLS or tool.startswith("read_")


def _is_write_tool(tool: str) -> bool:
    return tool in _WRITE_TOOLS or tool.startswith("write_") or "edit" in tool or "patch" in tool


def _is_shell_tool(tool: str) -> bool:
    return tool in _SHELL_TOOLS or "powershell" in tool


def _all_paths_inside_workspace(tool: str, arguments: dict[str, Any], workspace_root: Path) -> bool:
    paths = list(_extract_paths(tool, arguments))
    if not paths:
        return True
    return all(_is_inside_workspace(path, workspace_root) for path in paths)


def _extract_paths(tool: str, arguments: dict[str, Any]) -> list[Any]:
    paths: list[Any] = []
    for key, value in arguments.items():
        if key in _PATH_KEYS:
            paths.extend(_coerce_path_values(value))

    patch = arguments.get("patch")
    if "patch" in tool and isinstance(patch, str):
        paths.extend(_extract_patch_paths(patch))

    return paths


def _coerce_path_values(value: Any) -> list[Any]:
    if isinstance(value, (list, tuple, set)):
        return list(value)
    return [value]


def _extract_patch_paths(patch: str) -> list[str]:
    paths: list[str] = []
    for line in patch.splitlines():
        for prefix in _PATCH_FILE_PREFIXES:
            if line.startswith(prefix):
                paths.append(line[len(prefix) :].strip().strip("\"'"))
                break
    return paths


def _is_inside_workspace(path_value: Any, workspace_root: Path) -> bool:
    try:
        path = Path(path_value)
    except TypeError:
        return False

    if not path.is_absolute():
        path = workspace_root / path

    try:
        resolved = path.resolve()
        resolved.relative_to(workspace_root)
    except (OSError, ValueError):
        return False
    return True
