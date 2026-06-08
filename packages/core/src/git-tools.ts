import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import type { ToolSpec } from "./types.js";

interface GitPathInput {
  paths?: string[];
}

interface GitLogInput {
  limit: number;
}

interface GitOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export function buildGitTools(): ToolSpec[] {
  return [createGitStatusTool(), createGitDiffTool(), createGitLogTool(), createGitBranchTool()];
}

export function createGitStatusTool(): ToolSpec<unknown, GitOutput> {
  return {
    name: "git_status",
    description: "Return git status --short for the workspace.",
    risk: "read",
    concurrency: "parallel_safe",
    parse: (input) => input,
    execute: async (_input, context) => runGit(context.cwd, ["status", "--short"])
  };
}

export function createGitDiffTool(): ToolSpec<GitPathInput, GitOutput> {
  return {
    name: "git_diff",
    description: "Return git diff for the workspace, optionally scoped to workspace-relative paths.",
    risk: "read",
    concurrency: "parallel_safe",
    parse(input) {
      if (input === undefined || input === null) {
        return {};
      }
      if (typeof input !== "object" || !Array.isArray((input as { paths?: unknown }).paths ?? [])) {
        throw new Error("git_diff paths must be an array of strings");
      }
      const paths = (input as { paths?: unknown[] }).paths;
      if (paths !== undefined && !paths.every((path) => typeof path === "string")) {
        throw new Error("git_diff paths must be an array of strings");
      }
      return { paths: paths as string[] | undefined };
    },
    async execute(input, context) {
      const paths = (input.paths ?? []).map((path) => validateWorkspaceRelativePath(context.cwd, path));
      return runGit(context.cwd, paths.length > 0 ? ["diff", "--", ...paths] : ["diff"]);
    }
  };
}

export function createGitLogTool(): ToolSpec<GitLogInput, GitOutput> {
  return {
    name: "git_log",
    description: "Return recent git commits in one-line format.",
    risk: "read",
    concurrency: "parallel_safe",
    parse(input) {
      const rawLimit = typeof input === "object" && input !== null ? (input as { limit?: unknown }).limit : undefined;
      if (rawLimit !== undefined && typeof rawLimit !== "number") {
        throw new Error("git_log limit must be a number");
      }
      const limit = Math.min(50, Math.max(1, Math.floor(rawLimit ?? 5)));
      return { limit };
    },
    execute: async (input, context) => runGit(context.cwd, ["log", `-${input.limit}`, "--oneline"])
  };
}

export function createGitBranchTool(): ToolSpec<unknown, GitOutput> {
  return {
    name: "git_branch",
    description: "Return the current git branch name.",
    risk: "read",
    concurrency: "parallel_safe",
    parse: (input) => input,
    execute: async (_input, context) => runGit(context.cwd, ["branch", "--show-current"])
  };
}

async function runGit(cwd: string, args: string[]): Promise<GitOutput> {
  const result = await spawnText("git", args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git exited with ${result.exitCode}`);
  }
  return result;
}

function validateWorkspaceRelativePath(cwd: string, rawPath: string): string {
  const root = resolve(cwd);
  const candidate = resolve(root, rawPath);
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return rel;
  }
  throw new Error("Git path is outside the workspace");
}

function spawnText(command: string, args: string[], cwd: string): Promise<GitOutput> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolvePromise({ stdout, stderr, exitCode });
    });
  });
}
