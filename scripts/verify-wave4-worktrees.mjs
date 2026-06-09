#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const expectedHead = "82096a6";
const wave4Worktrees = [
  { label: "W18-CLI-Command-Architecture", name: "wave4-cli-command-architecture", branch: "codex/wave4-cli-command-architecture" },
  { label: "W19-SDK-AgentHub-Consumer-Fixture", name: "wave4-sdk-agenthub-consumer-fixture", branch: "codex/wave4-sdk-agenthub-consumer-fixture" },
  { label: "W20-TUI-Interaction-Polish", name: "wave4-tui-interaction-polish", branch: "codex/wave4-tui-interaction-polish" },
  { label: "W21-LLM-Real-Smoke-Gates", name: "wave4-llm-real-smoke-gates", branch: "codex/wave4-llm-real-smoke-gates" },
  { label: "W22-Permission-Policy-Audit", name: "wave4-permission-policy-audit", branch: "codex/wave4-permission-policy-audit" },
  { label: "W23-Thread-Session-Lifecycle", name: "wave4-thread-session-lifecycle", branch: "codex/wave4-thread-session-lifecycle" }
];

const args = new Set(process.argv.slice(2));
const json = args.has("--json");
const strictClean = args.has("--strict-clean");
const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, "..");

const results = wave4Worktrees.map((worktree) => inspectWorktree(worktree));
const ok = results.every((result) => result.ok);

if (json) {
  process.stdout.write(`${JSON.stringify({ ok, expectedHead, results }, null, 2)}\n`);
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
  const dirty = git(path, ["status", "--short"]);

  if (head.status !== 0) {
    issues.push(`could not read HEAD: ${head.stderr || head.stdout}`);
  } else if (!head.stdout.startsWith(expectedHead)) {
    issues.push(`expected HEAD prefix ${expectedHead}, got ${head.stdout}`);
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
