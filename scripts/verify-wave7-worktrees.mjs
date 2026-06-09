#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const expectedBase = "34e93cc";
const wave7Worktrees = [
  { label: "W41-CLI-Approval", name: "wave7-cli-approval", branch: "codex/wave7-cli-approval" },
  { label: "W42-Run-JSON", name: "wave7-run-json", branch: "codex/wave7-run-json" },
  { label: "W43-Permission-Subjects", name: "wave7-permission-subjects", branch: "codex/wave7-permission-subjects" },
  { label: "W44-Context-Budget", name: "wave7-context-budget", branch: "codex/wave7-context-budget" },
  { label: "W45-Runtime-Hooks", name: "wave7-runtime-hooks", branch: "codex/wave7-runtime-hooks" },
  { label: "W46-Session-Concurrency", name: "wave7-session-concurrency", branch: "codex/wave7-session-concurrency" }
];

const args = new Set(process.argv.slice(2));
const json = args.has("--json");
const strictClean = args.has("--strict-clean");
const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, "..");

const results = wave7Worktrees.map((worktree) => inspectWorktree(worktree));
const ok = results.every((result) => result.ok);

if (json) {
  process.stdout.write(`${JSON.stringify({ ok, expectedBase, results }, null, 2)}\n`);
} else {
  for (const result of results) {
    const marker = result.ok ? (result.dirty ? "DIRTY" : "PASS") : "FAIL";
    const path = result.path ?? "(missing)";
    console.log(`${marker} ${result.label} ${result.branch} ${result.head ?? "no-head"} ${path}`);
    for (const issue of result.issues) {
      console.log(`  - ${issue}`);
    }
  }
}

if (!ok) {
  process.exitCode = 1;
}

function inspectWorktree(worktree) {
  const path = resolveWorktreePath(worktree.name);
  const issues = [];
  if (!path) {
    return { ...worktree, ok: false, path: null, head: null, currentBranch: null, dirty: null, issues: ["worktree path was not found"] };
  }

  const head = git(path, ["rev-parse", "--short", "HEAD"]);
  const currentBranch = git(path, ["branch", "--show-current"]);
  const baseAncestor = git(path, ["merge-base", "--is-ancestor", expectedBase, "HEAD"]);
  const dirty = git(path, ["status", "--short"]);

  if (head.status !== 0) {
    issues.push(`could not read HEAD: ${head.stderr || head.stdout}`);
  } else if (baseAncestor.status !== 0) {
    issues.push(`expected ${expectedBase} to be an ancestor of ${head.stdout}`);
  }

  if (currentBranch.status !== 0) {
    issues.push(`could not read branch: ${currentBranch.stderr || currentBranch.stdout}`);
  } else if (currentBranch.stdout !== worktree.branch) {
    issues.push(`expected branch ${worktree.branch}, got ${currentBranch.stdout}`);
  }

  if (dirty.status !== 0) {
    issues.push(`could not read status: ${dirty.stderr || dirty.stdout}`);
  } else if (strictClean && dirty.stdout.length > 0) {
    issues.push(`worktree has local changes: ${dirty.stdout.replace(/\r?\n/g, "; ")}`);
  }

  return {
    ...worktree,
    ok: issues.length === 0,
    path,
    head: head.stdout || null,
    currentBranch: currentBranch.stdout || null,
    dirty: dirty.stdout || "",
    issues
  };
}

function resolveWorktreePath(name) {
  const candidates = [
    resolve(workspaceRoot, ".worktrees", name),
    resolve(workspaceRoot, "..", name),
    resolve(workspaceRoot, "..", "..", ".worktrees", name)
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim()
  };
}
