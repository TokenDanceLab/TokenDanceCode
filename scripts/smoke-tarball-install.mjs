import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = [
  { name: "@tokendance/code-core", prefix: "tokendance-code-core-" },
  { name: "@tokendance/code-sdk", prefix: "tokendance-code-sdk-" },
  { name: "@tokendance/code-cli", prefix: "tokendance-code-cli-" }
];

const tempRoot = await mkdtemp(join(tmpdir(), "tokendance-code-pack-smoke-"));
const tarballDir = join(tempRoot, "tarballs");
const smokeEnv = {
  ...process.env,
  HOME: tempRoot,
  USERPROFILE: tempRoot,
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  TOKENDANCE_GATEWAY_API_KEY: "",
  TOKENDANCE_PROVIDER: "",
  TOKENDANCE_MODEL: "",
  MODEL_ID: ""
};
const doctorJsonLabel = "doctor --json";
const qualityJsonLabel = "quality --json";
const forbiddenPackagePatterns = [
  { label: "Windows user path", pattern: /C:[\\/]+Users[\\/]+/i },
  { label: "local workspace path", pattern: /D:[\\/]+Code[\\/]+/i },
  { label: "npm token", pattern: /npm_[A-Za-z0-9]{20,}/ },
  { label: "npm auth token config", pattern: /_authToken\s*=/i },
  { label: "private key material", pattern: /BEGIN (?:RSA|OPENSSH|EC|PRIVATE) KEY/ }
];

try {
  await mkdir(tarballDir, { recursive: true });

  for (const pkg of packages) {
    run("pnpm", ["--filter", pkg.name, "pack", "--pack-destination", tarballDir], workspaceRoot);
  }

  const tarballs = await readdir(tarballDir);
  const dependencies = Object.fromEntries(
    packages.map((pkg) => {
      const file = tarballs.find((entry) => entry.startsWith(pkg.prefix) && entry.endsWith(".tgz"));
      if (!file) {
        throw new Error(`Missing packed tarball for ${pkg.name}`);
      }
      return [pkg.name, `file:${join(tarballDir, file).replaceAll("\\", "/")}`];
    })
  );

  await writeFile(
    join(tempRoot, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies,
      pnpm: {
        overrides: dependencies
      }
    }, null, 2),
    "utf8"
  );

  await writeFile(
    join(tempRoot, "smoke.mjs"),
    [
      "import { TOKEN_DANCE_CODE_PACKAGE, TokenDanceCode } from '@tokendance/code-sdk';",
      "if (TOKEN_DANCE_CODE_PACKAGE.verification.tarballSmoke !== 'pnpm pack:smoke') throw new Error('missing tarball smoke metadata');",
      "const client = new TokenDanceCode();",
      "const thread = client.startThread({ workingDirectory: process.cwd() });",
      "const turn = await thread.run('tarball smoke');",
      "if (!turn.finalResponse.includes('Mock response: tarball smoke')) throw new Error('SDK mock turn failed');"
    ].join("\n"),
    "utf8"
  );

  run("pnpm", ["install", "--ignore-scripts", "--frozen-lockfile=false"], tempRoot);
  await assertNoForbiddenPackageContent(join(tempRoot, "node_modules", "@tokendance"));
  run("node", ["smoke.mjs"], tempRoot);
  run("pnpm", ["exec", "tokendance", "--version"], tempRoot);
  const doctor = JSON.parse(runCapture("pnpm", ["exec", "tokendance", "doctor", "--json"], tempRoot, { env: smokeEnv, label: doctorJsonLabel }));
  if (doctor.agentHub?.ready !== true) {
    throw new Error("packed CLI doctor --json did not report agentHub.ready");
  }
  if (doctor.startup?.hub?.checks?.some((check) => check.name === "provider-ready" && check.status === "pass") !== true) {
    throw new Error("packed CLI doctor --json did not report provider-ready pass");
  }
  const quality = JSON.parse(runCapture("pnpm", ["exec", "tokendance", "quality", "--json", "Write-Output ok"], tempRoot, { env: smokeEnv, label: qualityJsonLabel }));
  if (quality.passed !== true || quality.result?.stdout?.includes("ok") !== true) {
    throw new Error("packed CLI quality --json did not report a passing PowerShell command");
  }

  console.log(`Tarball install smoke passed in ${tempRoot}`);
} finally {
  if (process.env.TOKENDANCE_KEEP_PACK_SMOKE !== "1") {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function run(command, args, cwd) {
  runCommand(command, args, cwd, { stdio: "inherit" });
}

function runCapture(command, args, cwd, options = {}) {
  const result = runCommand(command, args, cwd, { ...options, stdio: "pipe" });
  return result.stdout;
}

function runCommand(command, args, cwd, options = {}) {
  const result = process.platform === "win32" && command === "pnpm"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", [command, ...args].map(quoteCmdArg).join(" ")], {
      cwd,
      env: options.env ?? process.env,
      encoding: "utf8",
      stdio: options.stdio ?? "inherit"
    })
    : spawnSync(command, args, {
      cwd,
      env: options.env ?? process.env,
      encoding: "utf8",
      stdio: options.stdio ?? "inherit"
    });

  if (result.status !== 0) {
    const detail = result.error ? ` (${result.error.message})` : "";
    const label = options.label ? `${options.label}: ` : "";
    const stdout = result.stdout ? `\nstdout:\n${result.stdout}` : "";
    const stderr = result.stderr ? `\nstderr:\n${result.stderr}` : "";
    throw new Error(`${label}Command failed: ${command} ${args.join(" ")}${detail}${stdout}${stderr}`);
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

async function assertNoForbiddenPackageContent(root) {
  let scannedFiles = 0;
  for (const file of await listFiles(root)) {
    if (!isScannablePackageFile(file)) {
      continue;
    }
    scannedFiles += 1;
    const content = await readFile(file, "utf8");
    for (const forbidden of forbiddenPackagePatterns) {
      if (forbidden.pattern.test(content)) {
        throw new Error(`Packed package privacy scan failed: ${forbidden.label} in ${file}`);
      }
    }
  }
  if (scannedFiles === 0) {
    throw new Error(`Packed package privacy scan failed: no scannable package files found in ${root}`);
  }
}

async function listFiles(root, visited = new Set()) {
  const resolvedRoot = await realpath(root);
  if (visited.has(resolvedRoot)) {
    return [];
  }
  visited.add(resolvedRoot);

  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(path, visited));
    } else if (entry.isFile()) {
      files.push(path);
    } else if (entry.isSymbolicLink()) {
      const target = await stat(path).catch(() => undefined);
      if (target?.isDirectory()) {
        files.push(...await listFiles(path, visited));
      } else if (target?.isFile()) {
        files.push(path);
      }
    }
  }
  return files;
}

function isScannablePackageFile(path) {
  return /\.(?:js|mjs|cjs|d\.ts|map|json|md|txt)$/i.test(path);
}
