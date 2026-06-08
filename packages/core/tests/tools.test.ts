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
        concurrency: "exclusive"
      })
    );
    expect(metadata[0]).not.toHaveProperty("execute");
    expect(metadata[0]).not.toHaveProperty("parse");
  });
});
