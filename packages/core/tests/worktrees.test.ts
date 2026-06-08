import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { WorktreeManager } from "../src/index.js";

const execFileAsync = promisify(execFile);

describe("worktree manager", () => {
  it("creates, lists, and removes managed worktrees with dirty protection", async () => {
    const root = await initRepo();
    const manager = new WorktreeManager({ repositoryRoot: root });

    const created = await manager.create({ name: "stage15-wt" });

    expect(created).toMatchObject({
      name: "stage15-wt",
      path: join(root, ".worktrees", "stage15-wt"),
      branch: "codex/stage15-wt"
    });
    expect(await manager.list()).toEqual([expect.objectContaining({ name: "stage15-wt", branch: "codex/stage15-wt" })]);

    await writeFile(join(created.path, "dirty.txt"), "dirty\n", "utf8");

    await expect(manager.remove("stage15-wt")).rejects.toThrow("Worktree stage15-wt has uncommitted changes.");

    await manager.remove("stage15-wt", { discard: true });

    expect(await manager.list()).toEqual([]);
  });

  it("rejects unsafe worktree names", async () => {
    const root = await initRepo();
    const manager = new WorktreeManager({ repositoryRoot: root });

    await expect(manager.create({ name: "../escape" })).rejects.toThrow("Worktree name must contain only letters, numbers, dot, underscore, or dash.");
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
