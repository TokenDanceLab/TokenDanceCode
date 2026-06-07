from __future__ import annotations

from tokendance.core.events import RuntimeEvent
from tokendance.permissions.engine import PermissionEngine
from tokendance.tools.registry import ToolRegistry
from tokendance.tools.spec import ToolContext, ToolResult


class ToolOrchestrator:
    def __init__(self, registry: ToolRegistry, permission_engine: PermissionEngine | None = None) -> None:
        self.registry = registry
        self.permission_engine = permission_engine or PermissionEngine()

    def execute(self, name: str, arguments: dict, context: ToolContext) -> ToolResult:
        try:
            spec = self.registry.get(name)
        except KeyError:
            return ToolResult.error(f"Unknown tool: {name}")

        decision = self.permission_engine.evaluate(
            tool_name=name,
            arguments=arguments,
            mode=context.permission_mode,
            workspace_root=context.workspace_root,
        )
        self._record(
            context,
            RuntimeEvent(
                type="permission_decision",
                payload={
                    "tool": name,
                    "behavior": decision.behavior,
                    "reason": decision.reason,
                    "risk_level": decision.risk_level,
                },
            ),
        )
        if decision.behavior == "deny":
            return ToolResult.error(f"Permission denied: {decision.reason}")
        if decision.behavior == "ask":
            return ToolResult.error(f"Permission required: {decision.reason}")

        self._record(context, RuntimeEvent(type="tool_call_started", payload={"tool": name, "arguments": arguments}))
        try:
            result = spec.handler(context, arguments)
        except Exception as exc:
            result = ToolResult.error(str(exc))

        event_type = "tool_call_completed" if result.status == "ok" else "tool_call_failed"
        self._record(
            context,
            RuntimeEvent(
                type=event_type,
                payload={"tool": name, "status": result.status, "content": result.content},
                artifact_ref=result.artifact_ref,
            ),
        )
        return result

    def _record(self, context: ToolContext, event: RuntimeEvent) -> None:
        if context.transcript_writer is not None:
            context.transcript_writer.append(event)
