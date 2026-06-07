from __future__ import annotations

from typing import Any

from tokendance.agents import AgentManager
from tokendance.git.worktree import WorktreeService
from tokendance.tools.spec import ToolContext, ToolResult, ToolSpec


def subagent_run(context: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    try:
        manager = AgentManager(context.workspace_root)
        agent_type = str(arguments.get("agent_type", "investigator"))
        prompt = _required_arg(arguments, "prompt")
        if agent_type == "coding":
            result = manager.run_coding(
                prompt,
                worktree=arguments.get("worktree"),
                task_id=arguments.get("task_id"),
            )
        else:
            result = manager.run_readonly(prompt, agent_type=agent_type)
        return ToolResult.ok(content=result.summary, data={"result": result.to_dict()})
    except (KeyError, RuntimeError, ValueError) as exc:
        return ToolResult.error(str(exc))


def subagent_list(context: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    del arguments
    try:
        results = AgentManager(context.workspace_root).list()
        return ToolResult.ok(
            content="\n".join(f"{item.agent_id} [{item.agent_type.value}] {item.summary}" for item in results),
            data={"agents": [item.to_dict() for item in results]},
        )
    except (RuntimeError, ValueError) as exc:
        return ToolResult.error(str(exc))


def worktree_create(context: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    try:
        record = WorktreeService(context.workspace_root).create(
            _required_arg(arguments, "name"),
            task_id=arguments.get("task_id"),
        )
        return ToolResult.ok(
            content=f"Created worktree {record.name}",
            data={"worktree": record.to_dict()},
        )
    except (KeyError, RuntimeError, ValueError) as exc:
        return ToolResult.error(str(exc))


def worktree_list(context: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    del arguments
    try:
        records = WorktreeService(context.workspace_root).list()
        return ToolResult.ok(
            content="\n".join(f"{record.name} {record.path}" for record in records),
            data={"worktrees": [record.to_dict() for record in records]},
        )
    except (RuntimeError, ValueError) as exc:
        return ToolResult.error(str(exc))


def worktree_remove(context: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    try:
        result = WorktreeService(context.workspace_root).remove(
            _required_arg(arguments, "name"),
            discard_changes=bool(arguments.get("discard_changes", False)),
        )
        if not result.removed:
            return ToolResult.error(result.message)
        return ToolResult.ok(content=result.message, data={"removed": result.removed, "name": result.name})
    except (KeyError, RuntimeError, ValueError) as exc:
        return ToolResult.error(str(exc))


def build_subagent_tool_specs() -> list[ToolSpec]:
    return [
        ToolSpec("subagent_run", "Run a delegated subagent.", _subagent_run_schema(), "write", subagent_run),
        ToolSpec("subagent_list", "List delegated subagent results.", {"type": "object"}, "read", subagent_list),
        ToolSpec("worktree_create", "Create an isolated git worktree.", _worktree_create_schema(), "write", worktree_create),
        ToolSpec("worktree_list", "List Tokendance worktrees.", {"type": "object"}, "read", worktree_list),
        ToolSpec("worktree_remove", "Remove an isolated git worktree.", _worktree_remove_schema(), "write", worktree_remove),
    ]


def _required_arg(arguments: dict[str, Any], name: str) -> str:
    value = arguments.get(name)
    if value is None or str(value).strip() == "":
        raise ValueError(f"{name} is required.")
    return str(value).strip()


def _subagent_run_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "prompt": {"type": "string"},
            "agent_type": {"type": "string", "enum": ["investigator", "reviewer", "coding"]},
            "worktree": {"type": "string"},
            "task_id": {"type": "string"},
        },
        "required": ["prompt"],
    }


def _worktree_create_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {"name": {"type": "string"}, "task_id": {"type": "string"}},
        "required": ["name"],
    }


def _worktree_remove_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {"name": {"type": "string"}, "discard_changes": {"type": "boolean"}},
        "required": ["name"],
    }
