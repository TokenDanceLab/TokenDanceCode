import { describe, expect, it } from "vitest";
import { PermissionEngine, normalizeApprovalDecision, type ToolRisk, type ToolSpec } from "../src/index.js";

const shellTool: ToolSpec = {
  name: "shell",
  description: "run a command",
  risk: "shell",
  concurrency: "exclusive",
  parse: (input) => input,
  execute: async () => "ok"
};

const annotatedWriteTool: ToolSpec = {
  name: "write_file",
  description: "write a file",
  risk: "write",
  concurrency: "exclusive",
  safetyNotes: ["Workspace-relative paths only."],
  parse: (input) => input,
  execute: async () => "ok"
};

describe("PermissionEngine", () => {
  it("keeps default/safe/auto/yolo mode decisions stable across risk levels", () => {
    const risks: ToolRisk[] = ["read", "write", "shell", "network", "dangerous"];
    const expected = {
      default: ["allowed", "requires_approval", "requires_approval", "requires_approval", "requires_approval"],
      safe: ["allowed", "denied", "denied", "denied", "denied"],
      auto: ["allowed", "allowed", "allowed", "allowed", "requires_approval"],
      yolo: ["allowed", "allowed", "allowed", "allowed", "allowed"]
    } as const;

    for (const mode of ["default", "safe", "auto", "yolo"] as const) {
      const decisions = risks.map((risk) => new PermissionEngine(mode).decide(toolWithRisk(risk)).status);

      expect(decisions).toEqual(expected[mode]);
    }
  });

  it("requires approval for shell tools in default mode", () => {
    expect(new PermissionEngine("default").decide(shellTool).status).toBe("requires_approval");
  });

  it("explains the mode, tool, risk, and next action in approval reasons", () => {
    const decision = new PermissionEngine("default").decide(shellTool);

    expect(decision).toMatchObject({
      status: "requires_approval",
      reason: "mode=default tool=shell risk=shell action=approval_required: default mode requires approval before running shell tools",
      riskMetadata: {
        mode: "default",
        toolName: "shell",
        toolRisk: "shell",
        action: "approval_required",
        approvalScope: "tool_call",
        concurrency: "exclusive",
        safetyNotes: []
      }
    });
  });

  it("blocks shell tools in safe mode", () => {
    expect(new PermissionEngine("safe").decide(shellTool)).toMatchObject({
      status: "denied",
      reason: "mode=safe tool=shell risk=shell action=denied: safe mode only allows read-only tools",
      riskMetadata: {
        mode: "safe",
        toolName: "shell",
        toolRisk: "shell",
        action: "denied",
        approvalScope: "none"
      }
    });
  });

  it("allows shell tools in yolo mode", () => {
    expect(new PermissionEngine("yolo").decide(shellTool).status).toBe("allowed");
  });

  it("includes tool execution context and safety notes in reasons", () => {
    expect(new PermissionEngine("default").decide(annotatedWriteTool).reason).toBe(
      "mode=default tool=write_file risk=write action=approval_required: default mode requires approval before running write tools; concurrency=exclusive; safety=Workspace-relative paths only."
    );
  });

  it("normalizes approval callback decisions against the base risk metadata", () => {
    const baseDecision = new PermissionEngine("default").decide(shellTool);
    expect(baseDecision.status).toBe("requires_approval");

    const decision = normalizeApprovalDecision(baseDecision, {
      status: "allowed",
      reason: "external bridge approved",
      riskMetadata: {
        mode: "yolo",
        toolName: "forged",
        toolRisk: "read",
        action: "allowed",
        approvalScope: "none",
        concurrency: "parallel_safe",
        safetyNotes: ["forged metadata"]
      }
    });

    expect(decision).toMatchObject({
      status: "allowed",
      reason: "external bridge approved",
      riskMetadata: {
        mode: "default",
        toolName: "shell",
        toolRisk: "shell",
        action: "allowed",
        approvalScope: "none",
        concurrency: "exclusive",
        safetyNotes: []
      }
    });
  });
});

function toolWithRisk(risk: ToolRisk): ToolSpec {
  return {
    name: `${risk}_tool`,
    description: `${risk} fixture`,
    risk,
    concurrency: risk === "read" ? "parallel_safe" : "exclusive",
    parse: (input) => input,
    execute: async () => "ok"
  };
}
