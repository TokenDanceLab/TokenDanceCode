import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const releaseBranch = "release/npm-first";
const releaseRef = `refs/heads/${releaseBranch}`;
const registry = "https://registry.npmjs.org/";
const publicPackageTarballPrefixes = [
  { name: "@tokendance/code-core", prefix: "tokendance-code-core-" },
  { name: "@tokendance/code-sdk", prefix: "tokendance-code-sdk-" },
  { name: "@tokendance/code-cli", prefix: "tokendance-code-cli-" }
];

await main();

async function main() {
  const rootPackage = JSON.parse(await readFile(resolve(workspaceRoot, "package.json"), "utf8"));
  const failures = [];

  assertPublishPreconditions();
  await collect(failures, "registry next state", () => run("pnpm", ["registry:next:check"]));
  await collect(failures, "contract gate", () => run("pnpm", ["contract:check"]));
  await collect(failures, "verify gate", () => run("pnpm", ["verify"]));
  await collect(failures, "build gate", () => run("pnpm", ["build"]));
  await collect(failures, "pack dry-run gate", () => run("pnpm", ["pack:dry-run"]));
  throwIfFailures(rootPackage.version, failures);

  await collect(failures, "reviewed tarball smoke", () => packReviewedTarballs(rootPackage.version));
  throwIfFailures(rootPackage.version, failures);

  const currentBranch = currentGitBranch();
  console.log(`Release publish readiness passed for ${rootPackage.version} at ${releaseBranch} tip; current branch is ${currentBranch}.`);
}

function throwIfFailures(version, failures) {
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    throw new Error(`release publish readiness failed for ${version} with ${failures.length} issue(s)`);
  }
}

function assertPublishPreconditions() {
  assertCleanWorktree();
  assertReleaseBranchPointer();
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
    const lines = status.trim().split(/\r?\n/);
    throw new Error(`worktree must be clean before publish review; ${lines.length} changed path(s): ${summarizeDirtyStatus(lines)}`);
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

async function packReviewedTarballs(version) {
  const shortHead = runCapture("git", ["rev-parse", "--short=12", "HEAD"]).trim();
  const tarballDir = join(workspaceRoot, ".tmp", "release-publish", `${version}-${shortHead}`);
  await rm(tarballDir, { recursive: true, force: true });
  await mkdir(tarballDir, { recursive: true });
  run("node", ["scripts/smoke-tarball-install.mjs"], {
    env: { TOKENDANCE_PACK_TARBALL_DIR: tarballDir }
  });
  const tarballs = await collectReviewedTarballs(tarballDir);

  console.log("Reviewed publish tarballs:");
  for (const tarball of tarballs) {
    const hash = createHash("sha256").update(await readFile(tarball.path)).digest("hex");
    console.log(`- ${tarball.name}: ${tarball.path}`);
    console.log(`  sha256: ${hash}`);
    console.log(`  publish: npm publish "${tarball.path}" --access public --tag next --registry ${registry}`);
  }
}

async function collectReviewedTarballs(tarballDir) {
  const entries = await readdir(tarballDir);
  return publicPackageTarballPrefixes.map((pkg) => {
    const matches = entries.filter((entry) => entry.startsWith(pkg.prefix) && entry.endsWith(".tgz"));
    if (matches.length !== 1) {
      throw new Error(`${pkg.name} expected exactly one reviewed tarball in ${tarballDir}; found ${matches.length}`);
    }
    return { name: pkg.name, path: join(tarballDir, matches[0]) };
  });
}

function currentGitBranch() {
  return runCapture("git", ["branch", "--show-current"]).trim() || "<detached>";
}

function run(command, args, options = {}) {
  const result = runCommand(command, args, { ...options, stdio: "inherit" });
  return result.stdout;
}

function runCapture(command, args, options = {}) {
  const result = runCommand(command, args, { ...options, stdio: "pipe" });
  return result.stdout;
}

function runCommand(command, args, options) {
  const env = options.env ? { ...process.env, ...options.env } : process.env;
  const result = process.platform === "win32" && (command === "git" || command === "pnpm" || command === "npm")
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", [command, ...args].map(quoteCmdArg).join(" ")], {
      cwd: workspaceRoot,
      env,
      encoding: "utf8",
      stdio: options.stdio
    })
    : spawnSync(command, args, {
      cwd: workspaceRoot,
      env,
      encoding: "utf8",
      stdio: options.stdio
    });

  if (result.status !== 0) {
    const detail = result.error ? ` (${result.error.message})` : "";
    const stdout = result.stdout ? `\nstdout:\n${redactOutput(result.stdout)}` : "";
    const stderr = result.stderr ? `\nstderr:\n${redactOutput(result.stderr)}` : "";
    throw new Error(`command failed: ${command} ${args.join(" ")}${detail}${stdout}${stderr}`);
  }
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function summarizeDirtyStatus(lines) {
  const counts = new Map();
  for (const line of lines) {
    const status = line.slice(0, 2).trim() || "changed";
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()].map(([status, count]) => `${status}=${count}`).join(", ");
}

function redactOutput(text) {
  return text
    .replaceAll(workspaceRoot, "<workspace>")
    .replace(/C:[\\/]+Users[\\/]+[^\\/\s"'`]+/gi, "<windows-home>")
    .replace(/D:[\\/]+Code[\\/]+[^\s"'`]+/gi, "<workspace-path>")
    .replace(/\/(?:home|Users)\/[A-Za-z0-9._-]+/g, "<posix-home>")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "<provider-api-key>")
    .replace(/npm_[A-Za-z0-9]{20,}/g, "<npm-token>")
    .replace(/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}/g, "<github-token>");
}

function quoteCmdArg(value) {
  if (!/[\s"&|<>^]/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
}
