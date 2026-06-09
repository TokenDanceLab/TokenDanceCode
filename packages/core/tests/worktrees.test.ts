import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry, ToolOrchestrator, WorktreeManager, type SessionState } from "../src/index.js";

const execFileAsync = promisify(execFile);

describe("worktree manager", () => {
  it("creates, lists, and removes managed worktrees with dirty protection", async () => {
    const root = await initRepo();
    const manager = new WorktreeManager({ repositoryRoot: root });

    const created = await manager.create({ name: "stage15-wt" });

    expect(created).toMatchObject({
      name: "stage15-wt",
      path: join(root, ".worktrees", "stage15-wt"),
      branch: "codex/stage15-wt",
      dirty: false
    });
    expect(await manager.list()).toEqual([expect.objectContaining({ name: "stage15-wt", branch: "codex/stage15-wt", dirty: false })]);

    await writeFile(join(created.path, "dirty.txt"), "dirty\n", "utf8");

    expect(await manager.list()).toEqual([expect.objectContaining({ name: "stage15-wt", dirty: true, dirtyFiles: ["dirty.txt"], dirtyFileCount: 1 })]);
    await expect(manager.status("stage15-wt")).resolves.toMatchObject({ dirty: true, dirtyFiles: ["dirty.txt"], dirtyFileCount: 1 });
    await expect(manager.remove("stage15-wt")).rejects.toMatchObject({
      message: "Worktree stage15-wt has uncommitted changes: dirty.txt",
      dirtyFiles: ["dirty.txt"]
    });

    await manager.remove("stage15-wt", { discard: true });

    expect(await manager.list()).toEqual([]);
  });

  it("rejects unsafe worktree names", async () => {
    const root = await initRepo();
    const manager = new WorktreeManager({ repositoryRoot: root });

    await expect(manager.create({ name: "../escape" })).rejects.toThrow("Worktree name must contain only letters, numbers, dot, underscore, or dash.");
  });

  it("exposes worktree tools through the default registry", async () => {
    const root = await initRepo();
    const orchestrator = new ToolOrchestrator(createDefaultToolRegistry());

    const created = await orchestrator.execute(
      { id: "wt-create", name: "worktree_create", input: { name: "tool-wt" } },
      { ...createSession(root), permissionMode: "yolo" }
    );
    const listed = await orchestrator.execute({ id: "wt-list", name: "worktree_list", input: {} }, createSession(root));
    await writeFile(join(root, ".worktrees", "tool-wt", "dirty.txt"), "dirty\n", "utf8");
    const dirtyRemove = await orchestrator.execute(
      { id: "wt-remove-dirty", name: "worktree_remove", input: { name: "tool-wt" } },
      { ...createSession(root), permissionMode: "yolo" }
    );
    const removed = await orchestrator.execute(
      { id: "wt-remove", name: "worktree_remove", input: { name: "tool-wt", discard: true } },
      { ...createSession(root), permissionMode: "yolo" }
    );

    expect(created).toMatchObject({ ok: true });
    expect(JSON.stringify(created.output)).toContain("codex/tool-wt");
    expect(listed).toMatchObject({ ok: true });
    expect(JSON.stringify(listed.output)).toContain("tool-wt");
    expect(JSON.stringify(listed.output)).toContain("dirtyFileCount");
    expect(dirtyRemove).toMatchObject({ ok: false, error: "Worktree tool-wt has uncommitted changes: dirty.txt" });
    expect(removed).toMatchObject({ ok: true });
  });
});

async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tdcode-worktree-"));
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "TokenDance Test"], { cwd: root });
  await writeFile(join(root, "notes.txt"), "old\n", "utf8");
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
