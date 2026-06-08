from __future__ import annotations

import os
import platform
import sys
from dataclasses import dataclass
from pathlib import Path

from tokendance.agents import AgentManager
from tokendance.config import TokendanceConfig
from tokendance.context.compact import CompactService
from tokendance.context.memory import MemoryStore
from tokendance.context.resume import ResumeService
from tokendance.context.transcript_search import TranscriptSearcher
from tokendance.git.quality import QualityGate
from tokendance.git.review import ReviewService
from tokendance.git.revert import RevertService
from tokendance.git.service import GitService
from tokendance.git.worktree import WorktreeService
from tokendance.tasks import Task, TaskService, TodoItem, TodoService


@dataclass
class CommandContext:
    session_id: str
    provider: str = "anthropic"
    model: str = "claude-sonnet-4-6"
    permission_mode: str = "default"
    mode: str = "work"
    project_path: Path = Path.cwd()
    session_dir: Path | None = None
    transcript_path: Path | None = None
    home: Path | None = None


@dataclass(frozen=True)
class CommandResult:
    message: str
    exit_requested: bool = False
    clear_requested: bool = False


class CommandRouter:
    def handle(self, line: str, context: CommandContext) -> CommandResult:
        command, argument = _split_command(line)
        if command == "/help":
            return CommandResult(_help_text())
        if command == "/status":
            return CommandResult(_status_text(context))
        if command == "/clear":
            return CommandResult("", clear_requested=True)
        if command == "/exit":
            return CommandResult("Exit requested. Session saved.", exit_requested=True)
        if command == "/mode":
            return _set_mode(argument, context)
        if command == "/permissions":
            return _set_permissions(argument, context)
        if command == "/config":
            return CommandResult(_config_text(context))
        if command == "/doctor":
            return CommandResult(build_doctor_text())
        if command == "/memory":
            return _memory(argument, context)
        if command == "/transcript":
            return _transcript(argument, context)
        if command == "/compact":
            return _compact(context)
        if command == "/resume":
            return _resume(context)
        if command == "/diff":
            return _diff(context)
        if command == "/review":
            return _review(context)
        if command == "/revert":
            return _revert(argument, context)
        if command == "/quality":
            return _quality(argument, context)
        if command == "/tasks":
            return _tasks(argument, context)
        if command == "/todo":
            return _todo(argument, context)
        if command == "/agents":
            return _agents(context)
        if command == "/worktree":
            return _worktree(argument, context)
        return CommandResult(f"Unknown slash command: {command}")


def _split_command(line: str) -> tuple[str, str]:
    stripped = line.strip()
    command, _, argument = stripped.partition(" ")
    return command, argument.strip()


def _help_text() -> str:
    return "\n".join(
        [
            "会话",
            "  /help             显示帮助",
            "  /status           查看会话状态",
            "  /clear            清空终端",
            "  /exit             退出并保存",
            "",
            "模型与配置",
            "  /mode work|teach   切换输出风格",
            "  /permissions       切换权限模式 default|safe|auto|yolo",
            "  /config            查看当前配置",
            "  /doctor            诊断本地环境",
            "",
            "任务与计划",
            "  /tasks             管理持久任务",
            "  /todo              管理会话待办",
            "",
            "上下文与记忆",
            "  /compact           手动压缩上下文",
            "  /transcript        搜索 transcript",
            "  /resume            恢复历史会话",
            "  /memory            管理记忆",
            "",
            "代码变更",
            "  /diff              查看当前改动",
            "  /review            代码审查",
            "  /revert latest     回滚最近 patch",
            "  /quality           运行质量检查",
            "",
            "Subagent 与隔离",
            "  /agents            查看 subagent 状态",
            "  /worktree          管理 git worktree",
        ]
    )


def _status_text(context: CommandContext) -> str:
    return "\n".join(
        [
            f"Session: {context.session_id}",
            f"Mode: {context.mode}",
            f"Permissions: {context.permission_mode}",
            f"Provider: {context.provider}",
            f"Model: {context.model}",
        ]
    )


def _set_mode(argument: str, context: CommandContext) -> CommandResult:
    if not argument:
        return CommandResult(f"Current mode: {context.mode}")
    if argument not in {"work", "teach"}:
        return CommandResult("Usage: /mode work|teach")
    context.mode = argument
    return CommandResult(f"Mode switched to {context.mode}.")


def _set_permissions(argument: str, context: CommandContext) -> CommandResult:
    if not argument:
        return CommandResult(f"Current permission mode: {context.permission_mode}")
    if argument not in {"default", "safe", "auto", "yolo"}:
        return CommandResult("Usage: /permissions default|safe|auto|yolo")
    context.permission_mode = argument
    return CommandResult(f"Permission mode switched to {context.permission_mode}.")


def _config_text(context: CommandContext) -> str:
    config = TokendanceConfig(
        provider=context.provider,
        model=context.model,
        permission_mode=context.permission_mode,
    )
    return "\n".join(
        [
            f"provider = {config.provider}",
            f"model = {config.model}",
            f"permission_mode = {config.permission_mode}",
            f"executor_backend = {config.executor_backend}",
            f"project_state = {config.project_state}",
        ]
    )


def build_doctor_text() -> str:
    shell = (
        os.environ.get("SHELL")
        or os.environ.get("ComSpec")
        or ("PowerShell" if os.environ.get("PSModulePath") else "unknown")
    )
    return "\n".join(
        [
            f"Python: {sys.version.split()[0]}",
            f"OS: {platform.platform()}",
            f"Shell: {shell}",
            f"CWD: {Path.cwd()}",
        ]
    )


def _memory(argument: str, context: CommandContext) -> CommandResult:
    store = MemoryStore(project_root=context.project_path, home=context.home)
    if argument.startswith("add project "):
        store.add_project_memory(argument.removeprefix("add project ").strip())
        return CommandResult("Project memory saved.")
    if argument.startswith("add global "):
        store.add_global_memory(argument.removeprefix("add global ").strip())
        return CommandResult("Global memory saved.")
    project_entries = store.list_project_memory()
    global_entries = store.list_global_memory()
    lines = ["Project memory:"]
    lines.extend(f"- {entry}" for entry in project_entries)
    lines.append("Global memory:")
    lines.extend(f"- {entry}" for entry in global_entries)
    return CommandResult("\n".join(lines))


def _transcript(argument: str, context: CommandContext) -> CommandResult:
    if context.transcript_path is None:
        return CommandResult("No current transcript.")
    if argument.startswith("search "):
        query = argument.removeprefix("search ").strip()
        records = TranscriptSearcher(context.transcript_path).search(query)
        if not records:
            return CommandResult("No transcript matches.")
        lines = [
            f"seq={record['seq']} type={record['type']}"
            for record in records[:10]
        ]
        return CommandResult("\n".join(lines))
    return CommandResult("Usage: /transcript search <query>")


def _compact(context: CommandContext) -> CommandResult:
    if context.session_dir is None or context.transcript_path is None:
        return CommandResult("No current session to compact.")
    summary_path = CompactService(context.session_dir).manual_compact(context.transcript_path)
    return CommandResult(f"Compact summary written: {summary_path}")


def _resume(context: CommandContext) -> CommandResult:
    try:
        result = ResumeService(context.project_path).latest()
    except FileNotFoundError as exc:
        return CommandResult(str(exc))
    return CommandResult(
        f"Resumed session {result.state.session_id} with {len(result.recent_records)} recent transcript events."
    )


def _diff(context: CommandContext) -> CommandResult:
    try:
        diff = GitService(context.project_path).diff()
    except RuntimeError as exc:
        return CommandResult(str(exc))
    return CommandResult(diff or "No diff.")


def _review(context: CommandContext) -> CommandResult:
    try:
        diff = GitService(context.project_path).diff()
    except RuntimeError as exc:
        return CommandResult(str(exc))
    report = ReviewService().review_diff(diff)
    if not report.findings:
        return CommandResult("No review findings.")
    return CommandResult("\n".join(f"[{finding.severity}] {finding.message}" for finding in report.findings))


def _revert(argument: str, context: CommandContext) -> CommandResult:
    if argument != "latest":
        return CommandResult("Usage: /revert latest")
    if context.session_dir is None:
        return CommandResult("No current session for revert.")
    patches = sorted((context.session_dir / "edits").glob("patch-*.patch"))
    if not patches:
        return CommandResult("No patch artifacts found.")
    result = RevertService(context.project_path).revert_patch_artifact(patches[-1])
    return CommandResult(result.message)


def _quality(argument: str, context: CommandContext) -> CommandResult:
    if not argument:
        return CommandResult("Usage: /quality <command>")
    result = QualityGate(context.project_path).run(argument)
    return CommandResult(
        "\n".join(
            [
                f"exit_code: {result.exit_code}",
                result.stdout_preview.rstrip(),
                result.stderr_preview.rstrip(),
            ]
        ).strip()
    )


def _tasks(argument: str, context: CommandContext) -> CommandResult:
    command, rest = _split_command_argument(argument)
    service = TaskService(context.project_path)
    try:
        if command in {"", "list"}:
            tasks = service.list()
            if not tasks:
                return CommandResult("No tasks.")
            return CommandResult("\n".join(_format_task(task) for task in tasks))
        if command == "create":
            if not rest:
                return CommandResult("Usage: /tasks create <title>")
            task = service.create(title=rest)
            return CommandResult(f"Created {task.id} [{task.status.value}] {task.title}")
        if command == "status":
            task_id, status = _split_required_pair(rest, "Usage: /tasks status <task_id> <status>")
            task = service.update_status(task_id, status)
            return CommandResult(f"Updated {task.id} [{task.status.value}] {task.title}")
        if command == "get":
            if not rest:
                return CommandResult("Usage: /tasks get <task_id>")
            return CommandResult(_format_task(service.get(rest)))
    except (KeyError, ValueError) as exc:
        return CommandResult(str(exc))
    return CommandResult("Usage: /tasks [create <title>|status <task_id> <status>|get <task_id>]")


def _todo(argument: str, context: CommandContext) -> CommandResult:
    if context.session_dir is None:
        return CommandResult("No current session for todo.")
    command, rest = _split_command_argument(argument)
    service = TodoService(context.session_dir)
    try:
        if command in {"", "list"}:
            todos = service.list()
            if not todos:
                return CommandResult("No todos.")
            return CommandResult("\n".join(_format_todo(todo) for todo in todos))
        if command == "add":
            if not rest:
                return CommandResult("Usage: /todo add <content>")
            todo = service.write(content=rest)
            return CommandResult(f"Wrote {todo.id} [{todo.status.value}] {todo.content}")
        if command == "status":
            todo_id, status = _split_required_pair(rest, "Usage: /todo status <todo_id> <status>")
            todo = service.update(todo_id, status=status)
            return CommandResult(f"Updated {todo.id} [{todo.status.value}] {todo.content}")
    except (KeyError, ValueError) as exc:
        return CommandResult(str(exc))
    return CommandResult("Usage: /todo [add <content>|status <todo_id> <status>]")


def _agents(context: CommandContext) -> CommandResult:
    results = AgentManager(context.project_path).list()
    if not results:
        return CommandResult("No subagents.")
    return CommandResult(
        "\n".join(
            f"{result.agent_id} [{result.agent_type.value}] {result.summary}"
            for result in results
        )
    )


def _worktree(argument: str, context: CommandContext) -> CommandResult:
    command, rest = _split_worktree_argument(argument)
    service = WorktreeService(context.project_path)
    try:
        if command in {"", "list"}:
            records = service.list()
            if not records:
                return CommandResult("No worktrees.")
            return CommandResult("\n".join(f"{record.name} {record.path}" for record in records))
        if command == "create":
            name, task_id = _parse_worktree_create(rest)
            record = service.create(name, task_id=task_id)
            return CommandResult(f"Worktree {record.name} created at {record.path}")
        if command == "remove":
            name, discard = _parse_worktree_remove(rest)
            result = service.remove(name, discard_changes=discard)
            return CommandResult(result.message)
        if command == "keep":
            name = rest.strip()
            if not name:
                return CommandResult("Usage: /worktree keep <name>")
            return CommandResult(service.keep(name).message)
    except (KeyError, RuntimeError, ValueError) as exc:
        return CommandResult(str(exc))
    return CommandResult("Usage: /worktree list|create <name>|remove <name> [--discard]|keep <name>")


def _split_worktree_argument(argument: str) -> tuple[str, str]:
    command, _, rest = argument.strip().partition(" ")
    return command, rest.strip()


def _split_command_argument(argument: str) -> tuple[str, str]:
    command, _, rest = argument.strip().partition(" ")
    return command, rest.strip()


def _split_required_pair(argument: str, usage: str) -> tuple[str, str]:
    first, _, second = argument.strip().partition(" ")
    if not first or not second:
        raise ValueError(usage)
    return first, second.strip()


def _format_task(task: Task) -> str:
    return f"{task.id} [{task.status.value}] {task.title}"


def _format_todo(todo: TodoItem) -> str:
    return f"{todo.id} [{todo.status.value}] {todo.content}"


def _parse_worktree_create(argument: str) -> tuple[str, str | None]:
    parts = argument.split()
    if not parts:
        raise ValueError("Usage: /worktree create <name> [task_id]")
    return parts[0], parts[1] if len(parts) > 1 else None


def _parse_worktree_remove(argument: str) -> tuple[str, bool]:
    parts = argument.split()
    if not parts:
        raise ValueError("Usage: /worktree remove <name> [--discard]")
    return parts[0], "--discard" in parts[1:]
