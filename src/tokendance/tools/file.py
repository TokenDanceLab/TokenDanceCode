from __future__ import annotations

from pathlib import Path

from tokendance.storage.atomic import atomic_write_text
from tokendance.storage.paths import normalize_path
from tokendance.tools.spec import ToolContext, ToolResult, ToolSpec

_EXCLUDED_GLOB_PARTS = frozenset(
    {
        ".git",
        ".tokendance",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        ".venv",
        "__pycache__",
        "build",
        "dist",
        "node_modules",
        "venv",
    }
)
_EXCLUDED_GLOB_FILES = frozenset({".env"})


def read_file(context: ToolContext, arguments: dict) -> ToolResult:
    path = _workspace_path(context, arguments.get("path", ""))
    if path is None:
        return ToolResult.error("Path is outside the workspace.")
    if not path.exists():
        return ToolResult.error(f"File not found: {arguments.get('path', '')}")
    return ToolResult.ok(content=path.read_text(encoding="utf-8"))


def write_file(context: ToolContext, arguments: dict) -> ToolResult:
    path = _workspace_path(context, arguments.get("path", ""))
    if path is None:
        return ToolResult.error("Path is outside the workspace.")
    atomic_write_text(path, str(arguments.get("content", "")))
    return ToolResult.ok(content=f"Wrote {path.relative_to(context.workspace_root)}")


def edit_file(context: ToolContext, arguments: dict) -> ToolResult:
    path = _workspace_path(context, arguments.get("path", ""))
    if path is None:
        return ToolResult.error("Path is outside the workspace.")
    old_text = str(arguments.get("old_text", ""))
    new_text = str(arguments.get("new_text", ""))
    content = path.read_text(encoding="utf-8")
    if old_text not in content:
        return ToolResult.error("old_text was not found.")
    atomic_write_text(path, content.replace(old_text, new_text, 1))
    return ToolResult.ok(content=f"Edited {path.relative_to(context.workspace_root)}")


def glob_files(context: ToolContext, arguments: dict) -> ToolResult:
    pattern = str(arguments.get("pattern", ""))
    matches = [
        path.relative_to(context.workspace_root).as_posix()
        for path in sorted(Path(context.workspace_root).glob(pattern))
        if path.is_file() and not _is_excluded_glob_match(path, context.workspace_root)
    ]
    return ToolResult.ok(content="\n".join(matches), data={"matches": matches})


def build_file_tool_specs() -> list[ToolSpec]:
    return [
        ToolSpec("read_file", "Read a UTF-8 file by workspace-relative path.", _read_file_schema(), "read", read_file),
        ToolSpec("write_file", "Write a UTF-8 file by workspace-relative path.", _write_file_schema(), "write", write_file),
        ToolSpec("edit_file", "Replace exact text in a UTF-8 file.", _edit_file_schema(), "write", edit_file),
        ToolSpec("glob", "Find files by workspace-relative glob pattern.", _glob_schema(), "read", glob_files),
    ]


def _read_file_schema() -> dict:
    return {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Workspace-relative file path to read."},
        },
        "required": ["path"],
    }


def _write_file_schema() -> dict:
    return {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Workspace-relative file path to write."},
            "content": {"type": "string", "description": "Complete UTF-8 file content."},
        },
        "required": ["path", "content"],
    }


def _edit_file_schema() -> dict:
    return {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Workspace-relative file path to edit."},
            "old_text": {"type": "string", "description": "Exact text to replace."},
            "new_text": {"type": "string", "description": "Replacement text."},
        },
        "required": ["path", "old_text", "new_text"],
    }


def _glob_schema() -> dict:
    return {
        "type": "object",
        "properties": {
            "pattern": {
                "type": "string",
                "description": "Workspace-relative glob pattern, such as **/*.py. Internal directories are excluded.",
            },
        },
        "required": ["pattern"],
    }


def _is_excluded_glob_match(path: Path, workspace_root: Path) -> bool:
    relative = path.relative_to(workspace_root)
    if relative.name in _EXCLUDED_GLOB_FILES:
        return True
    return any(part in _EXCLUDED_GLOB_PARTS for part in relative.parts)


def _workspace_path(context: ToolContext, raw_path: str) -> Path | None:
    root = Path(context.workspace_root).resolve()
    candidate = (root / raw_path).resolve()
    root_key = normalize_path(root)
    candidate_key = normalize_path(candidate)
    if candidate_key != root_key and not candidate_key.startswith(root_key + "\\") and not candidate_key.startswith(root_key + "/"):
        return None
    return candidate
