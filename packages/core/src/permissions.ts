import type { PermissionDecision, PermissionMode, ToolSpec } from "./types.js";

export class PermissionEngine {
  constructor(private readonly mode: PermissionMode) {}

  decide(tool: ToolSpec): PermissionDecision {
    if (this.mode === "yolo") {
      return { status: "allowed", reason: "yolo mode allows all registered tools" };
    }

    if (this.mode === "auto") {
      return tool.risk === "dangerous"
        ? { status: "requires_approval", reason: "dangerous tools still require approval in auto mode" }
        : { status: "allowed", reason: "auto mode allows non-dangerous registered tools" };
    }

    if (this.mode === "safe") {
      return tool.risk === "read"
        ? { status: "allowed", reason: "safe mode allows read-only tools" }
        : { status: "denied", reason: `safe mode blocks ${tool.risk} tools` };
    }

    return tool.risk === "read"
      ? { status: "allowed", reason: "default mode allows read-only tools" }
      : { status: "requires_approval", reason: `default mode requires approval for ${tool.risk} tools` };
  }
}
