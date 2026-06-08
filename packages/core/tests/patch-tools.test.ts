import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry, parseSimpleUpdatePatch, ToolOrchestrator, type SessionState } from "../src/index.js";

describe("apply_patch tool", () => {
  it("applies a simple update patch inside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-patch-"));
    await writeFile(join(root, "notes.txt"), "hello\nold\n", "utf8");
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());

    const result = await orchestrator.execute(
      {
        id: "patch-1",
        name: "apply_patch",
        input: {
          patch: ["*** Begin Patch", "*** Update File: notes.txt", "@@", "-old", "+new", "*** End Patch"].join("\n")
        }
      },
      createSession(root, "yolo")
    );

    expect(result).toMatchObject({ ok: true, output: { path: "notes.txt", replacements: 1 } });
    await expect(readFile(join(root, "notes.txt"), "utf8")).resolves.toBe("hello\nnew\n");
  });

  it("rejects unsupported patch formats", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-patch-"));
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());

    const result = await orchestrator.execute(
      { id: "patch-bad", name: "apply_patch", input: { patch: "*** Begin Patch\n*** End Patch" } },
      createSession(root, "yolo")
    );

    expect(result).toMatchObject({ ok: false, error: "Unsupported patch format" });
  });

  it("rejects patch targets outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-patch-"));
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());

    const result = await orchestrator.execute(
      {
        id: "patch-outside",
        name: "apply_patch",
        input: {
          patch: ["*** Begin Patch", "*** Update File: ../outside.txt", "@@", "-old", "+new", "*** End Patch"].join("\n")
        }
      },
      createSession(root, "yolo")
    );

    expect(result).toMatchObject({ ok: false, error: "Patch target is outside the workspace" });
  });

  it("leaves the file unchanged when old text is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-patch-"));
    const filePath = join(root, "notes.txt");
    await writeFile(filePath, "hello\ncurrent\n", "utf8");
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());

    const result = await orchestrator.execute(
      {
        id: "patch-missing",
        name: "apply_patch",
        input: {
          patch: ["*** Begin Patch", "*** Update File: notes.txt", "@@", "-old", "+new", "*** End Patch"].join("\n")
        }
      },
      createSession(root, "yolo")
    );

    expect(result).toMatchObject({ ok: false, error: "Patch old text was not found" });
    await expect(readFile(filePath, "utf8")).resolves.toBe("hello\ncurrent\n");
  });

  it("parses simple update patches", () => {
    expect(
      parseSimpleUpdatePatch(["*** Begin Patch", "*** Update File: notes.txt", "@@", "-a", "-b", "+c", "+d"].join("\n"))
    ).toEqual({ targetPath: "notes.txt", oldText: "a\nb", newText: "c\nd" });
  });
});

function createSession(cwd: string, permissionMode: SessionState["permissionMode"]): SessionState {
  return {
    id: "test-session",
    cwd,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    permissionMode,
    messages: []
  };
}
