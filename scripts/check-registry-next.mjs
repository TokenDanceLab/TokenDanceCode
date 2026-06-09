import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const publicPackages = [
  "@tokendance/code-core",
  "@tokendance/code-sdk",
  "@tokendance/code-cli"
];
const registry = "https://registry.npmjs.org/";

await main();

async function main() {
  const rootPackage = JSON.parse(await readFile(resolve(workspaceRoot, "package.json"), "utf8"));
  const currentVersion = rootPackage.version;
  const failures = [];

  for (const packageName of publicPackages) {
    const result = runNpmView(packageName);
    if (result.status !== 0) {
      if (isNotFound(result)) {
        console.log(`${packageName}: E404 on npm; first publish candidate can proceed.`);
        continue;
      }
      failures.push(`${packageName}: npm view failed with exit ${result.status}${formatOutput(result)}`);
      continue;
    }

    const metadata = parseViewJson(result.stdout, packageName);
    const versions = Array.isArray(metadata.versions) ? metadata.versions : [];
    const nextTag = metadata["dist-tags"]?.next;
    if (versions.includes(currentVersion) || nextTag === currentVersion) {
      failures.push(`${packageName}: version ${currentVersion} already exists on npm; choose a new version before publishing.`);
      continue;
    }
    console.log(`${packageName}: current version ${currentVersion} not present; next=${nextTag ?? "<unset>"}.`);
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    throw new Error(`registry next check failed with ${failures.length} issue(s)`);
  }
}

function runNpmView(packageName) {
  return run("npm", ["view", packageName, "versions", "dist-tags", "--json", "--registry", registry]);
}

function run(command, args) {
  const result = process.platform === "win32"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", [command, ...args].map(quoteCmdArg).join(" ")], {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: "pipe"
    })
    : spawnSync(command, args, {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: "pipe"
    });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error
  };
}

function parseViewJson(stdout, packageName) {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch (error) {
    throw new Error(`${packageName}: npm view returned non-JSON output: ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error(`${packageName}: npm view returned an unexpected JSON payload`);
}

function isNotFound(result) {
  return /E404/.test(`${result.stdout}\n${result.stderr}`);
}

function formatOutput(result) {
  const detail = result.error ? ` (${result.error.message})` : "";
  const stdout = result.stdout.trim() ? `\nstdout:\n${result.stdout.trim()}` : "";
  const stderr = result.stderr.trim() ? `\nstderr:\n${result.stderr.trim()}` : "";
  return `${detail}${stdout}${stderr}`;
}

function quoteCmdArg(value) {
  if (!/[\s"&|<>^]/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
}
