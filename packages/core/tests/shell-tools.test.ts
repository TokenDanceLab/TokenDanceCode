import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry, ToolOrchestrator, type SessionState } from "../src/index.js";

describe("run_powershell tool", () => {
  it("executes safe commands in the workspace under yolo mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-shell-"));
    await writeFile(join(root, "hello.txt"), "hello", "utf8");
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());

    const result = await orchestrator.execute(
      { id: "shell-1", name: "run_powershell", input: { command: "Get-ChildItem -Name", timeout: 5 } },
      createSession(root, "yolo")
    );

    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({ exitCode: 0, timedOut: false });
    expect(JSON.stringify(result.output)).toContain("hello.txt");
  });

  it("denies dangerous commands before execution even in yolo mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-shell-"));
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());

    const result = await orchestrator.execute(
      { id: "shell-danger", name: "run_powershell", input: { command: "git reset --hard" } },
      createSession(root, "yolo")
    );

    expect(result).toMatchObject({ ok: false, error: "Permission denied by PowerShell risk classifier" });
  });

  it("requires approval in default mode through the permission engine", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdcode-shell-"));
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());

    const result = await orchestrator.execute(
      { id: "shell-default", name: "run_powershell", input: { command: "Get-ChildItem -Name" } },
      createSession(root, "default")
    );

    expect(result).toMatchObject({ ok: false, error: "default mode requires approval for shell tools" });
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
