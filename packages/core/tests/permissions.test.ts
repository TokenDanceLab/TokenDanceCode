import { describe, expect, it } from "vitest";
import { PermissionEngine, type ToolSpec } from "../src/index.js";

const shellTool: ToolSpec = {
  name: "shell",
  description: "run a command",
  risk: "shell",
  concurrency: "exclusive",
  parse: (input) => input,
  execute: async () => "ok"
};

describe("PermissionEngine", () => {
  it("requires approval for shell tools in default mode", () => {
    expect(new PermissionEngine("default").decide(shellTool).status).toBe("requires_approval");
  });

  it("explains the mode, tool, risk, and next action in approval reasons", () => {
    expect(new PermissionEngine("default").decide(shellTool)).toEqual({
      status: "requires_approval",
      reason: "mode=default tool=shell risk=shell action=approval_required: default mode requires approval before running shell tools"
    });
  });

  it("blocks shell tools in safe mode", () => {
    expect(new PermissionEngine("safe").decide(shellTool)).toEqual({
      status: "denied",
      reason: "mode=safe tool=shell risk=shell action=denied: safe mode only allows read-only tools"
    });
  });

  it("allows shell tools in yolo mode", () => {
    expect(new PermissionEngine("yolo").decide(shellTool).status).toBe("allowed");
  });
});
