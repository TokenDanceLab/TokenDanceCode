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

  it("blocks shell tools in safe mode", () => {
    expect(new PermissionEngine("safe").decide(shellTool).status).toBe("denied");
  });

  it("allows shell tools in yolo mode", () => {
    expect(new PermissionEngine("yolo").decide(shellTool).status).toBe("allowed");
  });
});
