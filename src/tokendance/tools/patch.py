from __future__ import annotations

from pathlib import Path

from tokendance.storage.atomic import atomic_write_text
from tokendance.tools.file import _workspace_path
from tokendance.tools.spec import ToolContext, ToolResult, ToolSpec


def apply_patch_tool(context: ToolContext, arguments: dict) -> ToolResult:
    patch = str(arguments.get("patch", ""))
    parsed = _parse_simple_update_patch(patch)
    if parsed is None:
        return ToolResult.error("Unsupported patch format.")
    target_path, old_text, new_text = parsed
    path = _workspace_path(context, target_path)
    if path is None:
        return ToolResult.error("Patch target is outside the workspace.")
    content = path.read_text(encoding="utf-8")
    if old_text not in content:
        return ToolResult.error("Patch old text was not found.")
    atomic_write_text(path, content.replace(old_text, new_text, 1))
    artifact_ref = _write_patch_artifact(context, patch)
    return ToolResult.ok(content=f"Applied patch to {target_path}", artifact_ref=artifact_ref)


def build_patch_tool_specs() -> list[ToolSpec]:
    return [
        ToolSpec("apply_patch", "Apply a small text patch.", {"type": "object"}, "write", apply_patch_tool)
    ]


def _parse_simple_update_patch(patch: str) -> tuple[str, str, str] | None:
    lines = patch.splitlines()
    target: str | None = None
    old_lines: list[str] = []
    new_lines: list[str] = []
    for line in lines:
        if line.startswith("*** Update File: "):
            target = line.removeprefix("*** Update File: ").strip()
        elif line.startswith("-") and not line.startswith("---"):
            old_lines.append(line[1:])
        elif line.startswith("+") and not line.startswith("+++"):
            new_lines.append(line[1:])
    if target is None or not old_lines:
        return None
    return target, "\n".join(old_lines), "\n".join(new_lines)


def _write_patch_artifact(context: ToolContext, patch: str) -> str | None:
    if context.session_dir is None:
        return None
    edits_dir = Path(context.session_dir) / "edits"
    edits_dir.mkdir(parents=True, exist_ok=True)
    index = len(list(edits_dir.glob("patch-*.patch"))) + 1
    artifact_ref = f"edits/patch-{index:04d}.patch"
    atomic_write_text(Path(context.session_dir) / artifact_ref, patch)
    return artifact_ref
