import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { join } from "node:path";
import type { ToolSpec } from "./types.js";
import { runPowerShell } from "./shell-tools.js";

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
  return [
    createGitStatusTool(),
    createGitDiffTool(),
    createGitLogTool(),
    createGitBranchTool(),
    createGitReviewTool(),
    createQualityGateTool()
  ];
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

export function createGitReviewTool(): ToolSpec<unknown, { findings: Array<{ severity: "high" | "medium"; message: string }> }> {
  return {
    name: "git_review",
    description: "Review current git diff for simple high-signal quality risks.",
    risk: "read",
    concurrency: "parallel_safe",
    parse: (input) => input,
    async execute(_input, context) {
      const diff = await runGit(context.cwd, ["diff"]);
      return { findings: reviewDiff(diff.stdout) };
    }
  };
}

export function createQualityGateTool(): ToolSpec<{ command?: string; timeoutMs: number }, { passed: boolean; command: string; result: GitOutput }> {
  return {
    name: "quality_gate",
    description: "Run a PowerShell quality command in the workspace and report pass/fail. Omitting command auto-discovers package verify scripts.",
    risk: "shell",
    concurrency: "exclusive",
    safetyNotes: ["PowerShell classifier hard-denies destructive override commands before execution."],
    parse(input) {
      if (input !== undefined && input !== null && typeof input !== "object") {
        throw new Error("quality_gate input must be an object");
      }
      const command = typeof input === "object" && input !== null ? (input as { command?: unknown }).command : undefined;
      if (command !== undefined && typeof command !== "string") {
        throw new Error("quality_gate command must be a string");
      }
      const timeout = typeof input === "object" && input !== null
        ? (input as { timeout?: unknown; timeoutMs?: unknown }).timeoutMs ?? (input as { timeout?: unknown }).timeout
        : undefined;
      if (timeout !== undefined && typeof timeout !== "number") {
        throw new Error("quality_gate timeout must be a number");
      }
      return {
        command: command?.trim() || undefined,
        timeoutMs: Math.max(1, Math.floor((timeout ?? 60) * 1000))
      };
    },
    async execute(input, context) {
      const command = input.command ?? await discoverQualityCommand(context.cwd);
      const result = await runPowerShell(command, context.cwd, input.timeoutMs);
      return { passed: result.exitCode === 0 && !result.timedOut, command, result };
    }
  };
}

export function reviewDiff(diff: string): Array<{ severity: "high" | "medium"; message: string }> {
  const findings: Array<{ severity: "high" | "medium"; message: string }> = [];
  if (diff.includes("<<<<<<<") || diff.includes(">>>>>>>")) {
    findings.push({ severity: "high", message: "Diff contains unresolved conflict markers." });
  }
  if (/^\+.*\bTODO\b/im.test(diff)) {
    findings.push({ severity: "medium", message: "Diff adds TODO text that may need a tracked follow-up." });
  }
  return findings;
}

async function runGit(cwd: string, args: string[]): Promise<GitOutput> {
  const result = await spawnText("git", args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git exited with ${result.exitCode}`);
  }
  return result;
}

async function discoverQualityCommand(cwd: string): Promise<string> {
  const packageJson = await readPackageJson(cwd);
  const scripts = typeof packageJson?.scripts === "object" && packageJson.scripts !== null
    ? packageJson.scripts as Record<string, unknown>
    : {};
  if (typeof scripts.verify === "string" && scripts.verify.trim()) {
    return packageManagerScriptCommand(packageJson, "verify");
  }
  if (typeof scripts.test === "string" && scripts.test.trim()) {
    return packageManagerScriptCommand(packageJson, "test");
  }
  throw new Error("No quality command provided and no package.json verify/test script was found.");
}

async function readPackageJson(cwd: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function packageManagerScriptCommand(packageJson: Record<string, unknown> | undefined, script: string): string {
  const packageManager = typeof packageJson?.packageManager === "string" ? packageJson.packageManager : "";
  if (packageManager.startsWith("pnpm@")) {
    return `pnpm ${script}`;
  }
  if (packageManager.startsWith("yarn@")) {
    return `yarn ${script}`;
  }
  return `npm run ${script} --silent`;
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
