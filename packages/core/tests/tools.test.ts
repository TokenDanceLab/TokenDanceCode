import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry } from "../src/index.js";

describe("tool registry metadata", () => {
  it("lists registered tool capabilities without exposing executors", () => {
    const metadata = createDefaultToolRegistry().metadata();

    expect(metadata).toContainEqual(
      expect.objectContaining({
        name: "read_file",
        risk: "read",
        concurrency: "parallel_safe"
      })
    );
    expect(metadata).toContainEqual(
      expect.objectContaining({
        name: "worktree_create",
        risk: "shell",
        concurrency: "exclusive",
        permission: expect.objectContaining({
          default: "requires_approval",
          safe: "denied",
          auto: "allowed",
          yolo: "allowed"
        })
      })
    );
    expect(metadata).toContainEqual(
      expect.objectContaining({
        name: "run_powershell",
        safetyNotes: expect.arrayContaining(["PowerShell classifier hard-denies destructive commands before execution."])
      })
    );
    expect(metadata[0]).not.toHaveProperty("execute");
    expect(metadata[0]).not.toHaveProperty("parse");
  });
});
