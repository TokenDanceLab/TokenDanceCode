import { describe, expect, it } from "vitest";
import { PermissionEngine, normalizeApprovalDecision, type PermissionSubject, type ToolRisk, type ToolSpec } from "../src/index.js";

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

  it("describes every permission profile with unified status, reason, and risk metadata", () => {
    const profiles = PermissionEngine.describeProfiles(shellTool);

    expect(profiles).toMatchObject({
      default: {
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
      },
      safe: expect.objectContaining({
        status: "denied",
        riskMetadata: expect.objectContaining({
          mode: "safe",
          action: "denied",
          approvalScope: "none"
        })
      }),
      auto: expect.objectContaining({
        status: "allowed",
        riskMetadata: expect.objectContaining({
          mode: "auto",
          action: "allowed"
        })
      }),
      yolo: expect.objectContaining({
        status: "allowed",
        riskMetadata: expect.objectContaining({
          mode: "yolo",
          action: "allowed"
        })
      })
    });
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

  it("requires approval for secret-like file subjects without changing the base tool mode decision", () => {
    const subject: PermissionSubject = {
      kind: "path",
      operation: "read",
      rawPath: "config/.env",
      normalizedPath: "config/.env",
      flags: ["secret_like"]
    };
    const engine = new PermissionEngine("yolo");

    expect(engine.decide(toolWithRisk("read")).status).toBe("allowed");
    expect(engine.decideSubject(toolWithRisk("read"), subject)).toMatchObject({
      status: "requires_approval",
      reason: "mode=yolo tool=read_tool risk=read action=approval_required subject=path:config/.env: secret-like path requires approval before access",
      riskMetadata: {
        mode: "yolo",
        toolName: "read_tool",
        toolRisk: "read",
        action: "approval_required",
        approvalScope: "tool_call",
        subject: {
          kind: "path",
          operation: "read",
          raw: "config/.env",
          normalized: "config/.env",
          flags: ["secret_like"]
        }
      }
    });
  });

  it("denies path subjects that escape the workspace after resolution", () => {
    const subject: PermissionSubject = {
      kind: "path",
      operation: "read",
      rawPath: "linked/outside.txt",
      normalizedPath: "linked/outside.txt",
      realPath: "../outside/outside.txt",
      flags: ["workspace_escape"]
    };

    expect(new PermissionEngine("yolo").decideSubject(toolWithRisk("read"), subject)).toMatchObject({
      status: "denied",
      reason: "mode=yolo tool=read_tool risk=read action=denied subject=path:linked/outside.txt: resolved path escapes the workspace"
    });
  });

  it("requires approval for shell command subjects that reference secret-like paths", () => {
    const subject: PermissionSubject = {
      kind: "shell_command",
      command: "Get-Content .env",
      flags: ["secret_like"]
    };

    expect(new PermissionEngine("auto").decideSubject(shellTool, subject)).toMatchObject({
      status: "requires_approval",
      reason: "mode=auto tool=shell risk=shell action=approval_required subject=shell_command:Get-Content .env: secret-like command input requires approval before execution"
    });
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
