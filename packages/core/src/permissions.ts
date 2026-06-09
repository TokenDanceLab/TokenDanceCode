import type { PermissionDecision, PermissionMode, ToolSpec } from "./types.js";

export class PermissionEngine {
  constructor(private readonly mode: PermissionMode) {}

  decide(tool: ToolSpec): PermissionDecision {
    if (this.mode === "yolo") {
      return allowed(this.mode, tool, "yolo mode allows registered tools; tool execution guards may still hard-deny unsafe inputs");
    }

    if (this.mode === "auto") {
      return tool.risk === "dangerous"
        ? requiresApproval(this.mode, tool, "auto mode requires approval before running dangerous tools")
        : allowed(this.mode, tool, "auto mode allows non-dangerous registered tools");
    }

    if (this.mode === "safe") {
      return tool.risk === "read"
        ? allowed(this.mode, tool, "safe mode allows read-only tools")
        : denied(this.mode, tool, "safe mode only allows read-only tools");
    }

    return tool.risk === "read"
      ? allowed(this.mode, tool, "default mode allows read-only tools")
      : requiresApproval(this.mode, tool, `default mode requires approval before running ${tool.risk} tools`);
  }
}

function allowed(mode: PermissionMode, tool: ToolSpec, detail: string): PermissionDecision {
  return { status: "allowed", reason: reason(mode, tool, "allowed", detail) };
}

function denied(mode: PermissionMode, tool: ToolSpec, detail: string): PermissionDecision {
  return { status: "denied", reason: reason(mode, tool, "denied", detail) };
}

function requiresApproval(mode: PermissionMode, tool: ToolSpec, detail: string): PermissionDecision {
  return { status: "requires_approval", reason: reason(mode, tool, "approval_required", detail) };
}

function reason(mode: PermissionMode, tool: ToolSpec, action: string, detail: string): string {
  return `mode=${mode} tool=${tool.name} risk=${tool.risk} action=${action}: ${detail}`;
}
