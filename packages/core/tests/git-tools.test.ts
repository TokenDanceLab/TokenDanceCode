import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry, reviewDiff, ToolOrchestrator, type SessionState } from "../src/index.js";

const execFileAsync = promisify(execFile);

describe("git tools", () => {
  it("reports status, diff, log, and branch", async () => {
    const root = await initRepo();
    await writeFile(join(root, "notes.txt"), "old\nnew\n", "utf8");
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());
    const session = createSession(root);

    const status = await orchestrator.execute({ id: "git-status", name: "git_status", input: {} }, session);
    const diff = await orchestrator.execute({ id: "git-diff", name: "git_diff", input: {} }, session);
    const log = await orchestrator.execute({ id: "git-log", name: "git_log", input: { limit: 1 } }, session);
    const branch = await orchestrator.execute({ id: "git-branch", name: "git_branch", input: {} }, session);

    expect(status).toMatchObject({ ok: true });
    expect(JSON.stringify(status.output)).toContain("M notes.txt");
    expect(diff).toMatchObject({ ok: true });
    expect(JSON.stringify(diff.output)).toContain("+new");
    expect(log).toMatchObject({ ok: true });
    expect(JSON.stringify(log.output)).toContain("initial");
    expect(branch.ok).toBe(true);
  });

  it("scopes diff paths inside the workspace", async () => {
    const root = await initRepo();
    await writeFile(join(root, "notes.txt"), "old\nnew\n", "utf8");
    await writeFile(join(root, "other.txt"), "other\nchange\n", "utf8");
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());

    const diff = await orchestrator.execute(
      { id: "git-diff", name: "git_diff", input: { paths: ["notes.txt"] } },
      createSession(root)
    );

    expect(diff.ok).toBe(true);
    expect(JSON.stringify(diff.output)).toContain("notes.txt");
    expect(JSON.stringify(diff.output)).not.toContain("other.txt");
  });

  it("rejects diff paths outside the workspace", async () => {
    const root = await initRepo();
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());

    const result = await orchestrator.execute(
      { id: "git-diff", name: "git_diff", input: { paths: ["../outside.txt"] } },
      createSession(root)
    );

    expect(result).toMatchObject({ ok: false, error: "Git path is outside the workspace" });
  });

  it("reviews diffs for conflict markers and TODO additions", () => {
    expect(reviewDiff("+<<<<<<< HEAD\n+bad\n+>>>>>>> branch\n+TODO follow up")).toEqual([
      { severity: "high", message: "Diff contains unresolved conflict markers." },
      { severity: "medium", message: "Diff adds TODO text that may need a tracked follow-up." }
    ]);
  });

  it("runs a quality gate command through PowerShell", async () => {
    const root = await initRepo();
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());

    const result = await orchestrator.execute(
      { id: "quality", name: "quality_gate", input: { command: "Get-ChildItem -Name", timeout: 5 } },
      { ...createSession(root), permissionMode: "yolo" }
    );

    expect(result).toMatchObject({ ok: true, output: { passed: true } });
    expect(JSON.stringify(result.output)).toContain("notes.txt");
  });

  it("discovers a package verify script when quality gate command is omitted", async () => {
    const root = await initRepo();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { verify: "node -e \"console.log('auto quality')\"" } }),
      "utf8"
    );
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());

    const result = await orchestrator.execute(
      { id: "quality-auto", name: "quality_gate", input: {} },
      { ...createSession(root), permissionMode: "yolo" }
    );

    expect(result).toMatchObject({ ok: true, output: { passed: true } });
    expect(JSON.stringify(result.output)).toContain("auto quality");
  });
});

async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tdcode-git-"));
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "TokenDance Test"], { cwd: root });
  await writeFile(join(root, "notes.txt"), "old\n", "utf8");
  await writeFile(join(root, "other.txt"), "other\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
  return root;
}

function createSession(cwd: string): SessionState {
  return {
    id: "test-session",
    cwd,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    permissionMode: "default",
    messages: []
  };
}
