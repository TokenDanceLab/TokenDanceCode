import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const releaseBranch = "release/npm-first";
const releaseRef = `refs/heads/${releaseBranch}`;

await main();

async function main() {
  const rootPackage = JSON.parse(await readFile(resolve(workspaceRoot, "package.json"), "utf8"));
  const failures = [];

  await collect(failures, "clean worktree", assertCleanWorktree);
  await collect(failures, "release branch pointer", assertReleaseBranchPointer);
  await collect(failures, "registry next state", () => run("pnpm", ["registry:next:check"]));
  await collect(failures, "release next gate", () => run("pnpm", ["release:next:check"]));

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    throw new Error(`release publish readiness failed for ${rootPackage.version} with ${failures.length} issue(s)`);
  }

  console.log(`Release publish readiness passed for ${rootPackage.version} on ${releaseBranch}.`);
}

async function collect(failures, label, check) {
  try {
    await check();
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertCleanWorktree() {
  const status = runCapture("git", ["status", "--porcelain"]);
  if (status.trim()) {
    throw new Error(`worktree must be clean before publish review:\n${status.trim()}`);
  }
}

function assertReleaseBranchPointer() {
  const head = runCapture("git", ["rev-parse", "HEAD"]).trim();
  const localRelease = runCapture("git", ["rev-parse", releaseBranch]).trim();
  const remoteRelease = runCapture("git", ["ls-remote", "origin", releaseRef]).trim().split(/\s+/)[0] ?? "";

  if (!localRelease) {
    throw new Error(`${releaseBranch} does not exist locally`);
  }
  if (!remoteRelease) {
    throw new Error(`origin/${releaseBranch} was not found`);
  }
  if (head !== localRelease) {
    throw new Error(`HEAD ${head} must match local ${releaseBranch} ${localRelease}`);
  }
  if (head !== remoteRelease) {
    throw new Error(`HEAD ${head} must match origin/${releaseBranch} ${remoteRelease}`);
  }
}

function run(command, args) {
  const result = runCommand(command, args, { stdio: "inherit" });
  return result.stdout;
}

function runCapture(command, args) {
  const result = runCommand(command, args, { stdio: "pipe" });
  return result.stdout;
}

function runCommand(command, args, options) {
  const result = process.platform === "win32" && (command === "git" || command === "pnpm" || command === "npm")
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", [command, ...args].map(quoteCmdArg).join(" ")], {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: options.stdio
    })
    : spawnSync(command, args, {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: options.stdio
    });

  if (result.status !== 0) {
    const detail = result.error ? ` (${result.error.message})` : "";
    const stdout = result.stdout ? `\nstdout:\n${result.stdout}` : "";
    const stderr = result.stderr ? `\nstderr:\n${result.stderr}` : "";
    throw new Error(`command failed: ${command} ${args.join(" ")}${detail}${stdout}${stderr}`);
  }
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function quoteCmdArg(value) {
  if (!/[\s"&|<>^]/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
}
