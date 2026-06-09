#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const expectedBase = "0f631f3";
const wave5Worktrees = [
  { label: "W24-Reference-Architecture", name: "wave5-reference-architecture", branch: "codex/wave5-reference-architecture" },
  { label: "W25-Release-NPM-Baseline", name: "wave5-release-npm-baseline", branch: "codex/wave5-release-npm-baseline" },
  { label: "W26-SDK-AgentHub-Contract", name: "wave5-sdk-agenthub-contract", branch: "codex/wave5-sdk-agenthub-contract" },
  { label: "W27-AgentHub-Consumer-Fixture", name: "wave5-agenthub-consumer-fixture", branch: "codex/wave5-agenthub-consumer-fixture" },
  { label: "W28-Gateway-Quickstart", name: "wave5-gateway-quickstart", branch: "codex/wave5-gateway-quickstart" },
  { label: "W29-TokenDanceID-OIDC", name: "wave5-tokendanceid-oidc", branch: "codex/wave5-tokendanceid-oidc" },
  { label: "W30-Provider-Hardening", name: "wave5-provider-hardening", branch: "codex/wave5-provider-hardening" },
  { label: "W31-Permission-Safety", name: "wave5-permission-safety", branch: "codex/wave5-permission-safety" },
  { label: "W32-CLI-TUI-Polish", name: "wave5-cli-tui-polish", branch: "codex/wave5-cli-tui-polish" },
  { label: "W33-Session-Subagent", name: "wave5-session-subagent", branch: "codex/wave5-session-subagent" }
];

const args = new Set(process.argv.slice(2));
const json = args.has("--json");
const strictClean = args.has("--strict-clean");
const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, "..");

const results = wave5Worktrees.map((worktree) => inspectWorktree(worktree));
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
