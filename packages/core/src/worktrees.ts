import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ToolSpec } from "./types.js";

const execFileAsync = promisify(execFile);

export interface WorktreeManagerOptions {
  repositoryRoot: string;
  worktreeRoot?: string;
}

export interface CreateWorktreeInput {
  name: string;
  branch?: string;
}

export interface RemoveWorktreeOptions {
  discard?: boolean;
}

export interface WorktreeRecord {
  name: string;
  path: string;
  branch?: string;
  head?: string;
  detached: boolean;
}

interface PorcelainWorktree {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
}

export class WorktreeManager {
  private readonly repositoryRoot: string;
  private readonly worktreeRoot: string;

  constructor(options: WorktreeManagerOptions) {
    this.repositoryRoot = resolve(options.repositoryRoot);
    this.worktreeRoot = resolve(options.worktreeRoot ?? join(this.repositoryRoot, ".worktrees"));
  }

  async list(): Promise<WorktreeRecord[]> {
    const output = await this.git(["worktree", "list", "--porcelain"]);
    return parseWorktreePorcelain(output.stdout)
      .filter((worktree) => this.isManagedPath(worktree.path))
      .map((worktree) => ({
        name: basename(worktree.path),
        path: resolve(worktree.path),
        branch: worktree.branch,
        head: worktree.head,
        detached: worktree.detached
      }));
  }

  async create(input: CreateWorktreeInput): Promise<WorktreeRecord> {
    const name = validateWorktreeName(input.name);
    const targetPath = this.pathForName(name);
    const branch = input.branch?.trim() || `codex/${name}`;
    await mkdir(dirname(targetPath), { recursive: true });
    await this.git(["worktree", "add", "-b", branch, targetPath, "HEAD"]);
    const created = (await this.list()).find((worktree) => worktree.name === name);
    if (!created) {
      throw new Error(`Worktree ${name} was not created.`);
    }
    return created;
  }

  async remove(name: string, options: RemoveWorktreeOptions = {}): Promise<void> {
    const safeName = validateWorktreeName(name);
    const worktree = (await this.list()).find((candidate) => candidate.name === safeName);
    if (!worktree) {
      throw new Error(`Worktree ${safeName} was not found.`);
    }
    const status = await this.git(["-C", worktree.path, "status", "--porcelain"]);
    if (status.stdout.trim() && !options.discard) {
      throw new Error(`Worktree ${safeName} has uncommitted changes.`);
    }
    await this.git(options.discard ? ["worktree", "remove", "--force", worktree.path] : ["worktree", "remove", worktree.path]);
  }

  private pathForName(name: string): string {
    const targetPath = resolve(this.worktreeRoot, name);
    const rel = relative(this.worktreeRoot, targetPath);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error("Worktree path is outside the managed worktree root.");
    }
    return targetPath;
  }

  private isManagedPath(path: string): boolean {
    const rel = relative(this.worktreeRoot, resolve(path));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  }

  private async git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync("git", args, { cwd: this.repositoryRoot, windowsHide: true });
      return { stdout: String(stdout), stderr: String(stderr) };
    } catch (error) {
      const candidate = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
      const message = String(candidate.stderr || candidate.stdout || candidate.message || "git command failed").trim();
      throw new Error(message);
    }
  }
}

export function buildWorktreeTools(): ToolSpec[] {
  return [createWorktreeListTool(), createWorktreeCreateTool(), createWorktreeRemoveTool()];
}

export function createWorktreeListTool(): ToolSpec<unknown, WorktreeRecord[]> {
  return {
    name: "worktree_list",
    description: "List TokenDanceCode managed git worktrees under .worktrees.",
    risk: "read",
    concurrency: "parallel_safe",
    parse: (input) => input,
    execute: async (_input, context) => new WorktreeManager({ repositoryRoot: context.cwd }).list()
  };
}

export function createWorktreeCreateTool(): ToolSpec<CreateWorktreeInput, WorktreeRecord> {
  return {
    name: "worktree_create",
    description: "Create a managed git worktree under .worktrees.",
    risk: "shell",
    concurrency: "exclusive",
    parse(input) {
      if (typeof input !== "object" || input === null || typeof (input as { name?: unknown }).name !== "string") {
        throw new Error("worktree_create input requires a string name field");
      }
      const branch = (input as { branch?: unknown }).branch;
      if (branch !== undefined && typeof branch !== "string") {
        throw new Error("worktree_create branch must be a string");
      }
      return { name: (input as { name: string }).name, branch };
    },
    execute: async (input, context) => new WorktreeManager({ repositoryRoot: context.cwd }).create(input)
  };
}

export function createWorktreeRemoveTool(): ToolSpec<{ name: string; discard?: boolean }, { removed: string }> {
  return {
    name: "worktree_remove",
    description: "Remove a managed git worktree, refusing dirty changes unless discard is true.",
    risk: "shell",
    concurrency: "exclusive",
    parse(input) {
      if (typeof input !== "object" || input === null || typeof (input as { name?: unknown }).name !== "string") {
        throw new Error("worktree_remove input requires a string name field");
      }
      const discard = (input as { discard?: unknown }).discard;
      if (discard !== undefined && typeof discard !== "boolean") {
        throw new Error("worktree_remove discard must be a boolean");
      }
      return { name: (input as { name: string }).name, discard };
    },
    async execute(input, context) {
      await new WorktreeManager({ repositoryRoot: context.cwd }).remove(input.name, { discard: input.discard });
      return { removed: input.name };
    }
  };
}

export function validateWorktreeName(name: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed) || trimmed === "." || trimmed === "..") {
    throw new Error("Worktree name must contain only letters, numbers, dot, underscore, or dash.");
  }
  return trimmed;
}

function parseWorktreePorcelain(output: string): PorcelainWorktree[] {
  const worktrees: PorcelainWorktree[] = [];
  let current: PorcelainWorktree | undefined;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (current) {
        worktrees.push(current);
        current = undefined;
      }
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current) {
        worktrees.push(current);
      }
      current = { path: line.slice("worktree ".length), detached: false };
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
      continue;
    }
    if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      continue;
    }
    if (line === "detached") {
      current.detached = true;
    }
  }
  if (current) {
    worktrees.push(current);
  }
  return worktrees;
}
