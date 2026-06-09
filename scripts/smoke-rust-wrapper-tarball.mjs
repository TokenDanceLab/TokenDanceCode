import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await mkdtemp(join(tmpdir(), "tokendance-rust-wrapper-smoke-"));
const tarballDir = join(tempRoot, "tarballs");
const binName = process.platform === "win32" ? "tokendance.exe" : "tokendance";
const installedBinaryPath = join(tempRoot, "node_modules", "target", "debug", binName);
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

const forbiddenPackagePatterns = [
  { label: "Windows user path", pattern: /C:[\\/]+Users[\\/]+/i },
  { label: "local workspace path", pattern: /D:[\\/]+Code[\\/]+/i },
  { label: "OpenAI-style API key", pattern: /sk-[A-Za-z0-9_-]{20,}/ },
  { label: "GitHub token", pattern: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}/ },
  { label: "npm token", pattern: /npm_[A-Za-z0-9]{20,}/ },
  { label: "npm auth token config", pattern: /_authToken\s*=/i },
  { label: "provider API key assignment", pattern: /\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|TOKENDANCE_GATEWAY_API_KEY)\s*=\s*(?!<[^>\r\n]+>|your-|""|'')\S+/i },
  { label: "private key material", pattern: /BEGIN (?:RSA|OPENSSH|EC|PRIVATE) KEY/ }
];

try {
  await mkdir(tarballDir, { recursive: true });

  const nativeBinary = await findOrBuildRustBinary();
  const packed = packCliWrapper();
  assertPackedFiles(packed);

  await writeFile(
    join(tempRoot, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@tokendance/code-cli": `file:${packed.filename.replaceAll("\\", "/")}`
      }
    }, null, 2),
    "utf8"
  );

  run("npm", ["install", "--ignore-scripts", "--package-lock-only=false"], tempRoot);
  await copySmokeBinary(nativeBinary);
  await assertNoForbiddenPackageContent(join(tempRoot, "node_modules", "@tokendance", "code-cli"));
  await assertInstalledManifest();

  const version = runCapture("npm", ["exec", "--", "tokendance", "--version"], tempRoot, { env: smokeEnv, label: "tokendance --version" }).trim();
  if (!/^tokendance 0\.3\.0-rs\.0$/.test(version)) {
    throw new Error(`tokendance --version returned unexpected output: ${version}`);
  }

  const doctor = JSON.parse(runCapture("npm", ["exec", "--", "tokendance", "doctor", "--json"], tempRoot, { env: smokeEnv, label: "tokendance doctor --json" }));
  if (doctor.version !== "0.3.0-rs.0" || doctor.rust_runtime !== true) {
    throw new Error(`tokendance doctor --json returned unexpected payload: ${JSON.stringify(doctor)}`);
  }

  console.log(`Rust wrapper tarball smoke passed with ${packed.filename}`);
} finally {
  if (process.env.TOKENDANCE_KEEP_RUST_WRAPPER_SMOKE !== "1") {
    await rm(tempRoot, { recursive: true, force: true });
  } else {
    console.log(`Kept smoke temp dir: ${tempRoot}`);
  }
}

async function findOrBuildRustBinary() {
  for (const profile of ["release", "debug"]) {
    const candidate = join(workspaceRoot, "target", profile, binName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  run("cargo", ["build", "-p", "tokendance-cli"], workspaceRoot);
  const built = join(workspaceRoot, "target", "debug", binName);
  if (!existsSync(built)) {
    throw new Error(`cargo build completed but ${built} was not found`);
  }
  return built;
}

function packCliWrapper() {
  const output = runCapture("npm", ["pack", "./packages/cli", "--pack-destination", tarballDir, "--json"], workspaceRoot, { label: "npm pack ./packages/cli" });
  const packed = JSON.parse(output)[0];
  if (!packed?.filename || !Array.isArray(packed.files)) {
    throw new Error(`npm pack returned unexpected JSON: ${output}`);
  }
  return {
    ...packed,
    filename: resolve(tarballDir, packed.filename)
  };
}

function assertPackedFiles(packed) {
  const paths = packed.files.map((file) => file.path);
  for (const expected of ["bin/tokendance.js", "package.json", "README.md"]) {
    if (!paths.includes(expected)) {
      throw new Error(`packed CLI wrapper missing ${expected}`);
    }
  }

  for (const path of paths) {
    if (/^(?:src|tests|dist|target|crates|scripts)\//.test(path) || /\.(?:env|log|sqlite|db|pdb)$/i.test(path) || path === "pnpm-lock.yaml" || path === ".npmrc") {
      throw new Error(`packed CLI wrapper contains private or build-only file: ${path}`);
    }
  }
}

async function copySmokeBinary(nativeBinary) {
  await mkdir(dirname(installedBinaryPath), { recursive: true });
  await copyFile(nativeBinary, installedBinaryPath);
}

async function assertInstalledManifest() {
  const manifest = JSON.parse(await readFile(join(tempRoot, "node_modules", "@tokendance", "code-cli", "package.json"), "utf8"));
  if (JSON.stringify(manifest.bin) !== JSON.stringify({ tokendance: "./bin/tokendance.js" })) {
    throw new Error(`packed CLI wrapper bin drifted: ${JSON.stringify(manifest.bin)}`);
  }
  if (manifest.dependencies || manifest.devDependencies) {
    throw new Error("packed CLI wrapper must not ship runtime dependencies");
  }
}

function run(command, args, cwd, options = {}) {
  runCommand(command, args, cwd, { stdio: "inherit", ...options });
}

function runCapture(command, args, cwd, options = {}) {
  const result = runCommand(command, args, cwd, { stdio: "pipe", ...options });
  return result.stdout;
}

function runCommand(command, args, cwd, options = {}) {
  const result = process.platform === "win32" && (command === "pnpm" || command === "npm")
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
        throw new Error(`Packed CLI wrapper privacy scan failed: ${forbidden.label} in ${file}`);
      }
    }
  }
  if (scannedFiles === 0) {
    throw new Error(`Packed CLI wrapper privacy scan failed: no scannable package files found in ${root}`);
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
