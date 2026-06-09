import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const expectedVerify = "cargo fmt --all -- --check && cargo test --workspace";
const packageManifestPaths = [
  "package.json",
  "packages/cli/package.json",
  "packages/core/package.json",
  "packages/sdk/package.json",
  "packages/agenthub-example/package.json"
];

const failures = [];

await collect("root verify script", assertVerifyScript);
await collect("publish script boundary", assertNoPublishScripts);
await collect("npm wrapper scaffold", assertNpmWrapperScaffold);
await collect("release readiness docs", assertReleaseReadinessDocs);
await collect("rust architecture docs", assertRustArchitectureDocs);

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  throw new Error(`Rust release plan check failed with ${failures.length} issue(s).`);
}

console.log("Rust release plan check passed: Cargo verify, no publish scripts, and npm wrapper docs are aligned.");

async function collect(label, check) {
  try {
    await check();
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function assertVerifyScript() {
  const rootPackage = await readJson("package.json");
  assert(rootPackage.private === true, "workspace root must stay private");
  assert(rootPackage.scripts?.verify === expectedVerify, `pnpm verify must remain '${expectedVerify}'`);
}

async function assertNoPublishScripts() {
  const manifestPaths = await existingManifestPaths();
  for (const manifestPath of manifestPaths) {
    const manifest = await readJson(manifestPath);
    for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
      const text = String(command);
      assert(!/\bnpm\s+publish\b/.test(text), `${manifestPath} script '${name}' must not run npm publish`);
      assert(!/\bpnpm\s+publish\b/.test(text), `${manifestPath} script '${name}' must not run pnpm publish`);
      assert(!/\byarn\s+npm\s+publish\b/.test(text), `${manifestPath} script '${name}' must not run yarn npm publish`);
    }
  }
}

async function assertNpmWrapperScaffold() {
  const cliPackage = await readJson("packages/cli/package.json");
  assert(cliPackage.version === "0.3.0-rs.0", "CLI package version must match the Rust workspace prerelease");
  assertJsonEqual(cliPackage.bin, { tokendance: "./bin/tokendance.js" }, "CLI package must expose the Rust wrapper bin");
  assertJsonEqual(cliPackage.files, ["bin", "README.md"], "CLI package files must include only wrapper bin and README");
  assert(cliPackage.scripts?.build === "cargo build -p tokendance-cli", "CLI build script must build the Rust CLI crate");
  assert(cliPackage.scripts?.test === "cargo test -p tokendance-cli", "CLI test script must test the Rust CLI crate");
  assert(!("main" in cliPackage), "CLI package must not point main at legacy TypeScript dist");
  assert(!("types" in cliPackage), "CLI package must not point types at legacy TypeScript dist");
  assert(!("dependencies" in cliPackage), "CLI wrapper package must not depend on legacy workspace packages");

  const wrapper = await readText("packages/cli/bin/tokendance.js");
  for (const expected of [
    "#!/usr/bin/env node",
    "@tokendance/code-cli-win32-x64-msvc",
    "target/release/tokendance",
    "target/debug/tokendance",
    "spawnSync",
    "Unsupported platform"
  ]) {
    assert(wrapper.includes(expected), `packages/cli/bin/tokendance.js missing '${expected}'`);
  }
}

async function assertReleaseReadinessDocs() {
  const text = await readText("docs/release-readiness.md");
  for (const expected of [
    "Rust-first npm binary wrapper",
    "optional native packages",
    expectedVerify,
    "release:rust:plan:check",
    "No package script may run `npm publish`",
    "@tokendance/code-cli-win32-x64-msvc",
    "Manual release-owner action"
  ]) {
    assert(text.includes(expected), `docs/release-readiness.md missing '${expected}'`);
  }
}

async function assertRustArchitectureDocs() {
  const text = await readText("docs/rust-rewrite-architecture.md");
  for (const expected of [
    "Rust-first npm binary wrapper",
    "optionalDependencies",
    "packages/cli/bin/tokendance.js",
    "crates/tokendance-cli",
    "Do not add publish scripts"
  ]) {
    assert(text.includes(expected), `docs/rust-rewrite-architecture.md missing '${expected}'`);
  }
}

async function existingManifestPaths() {
  const paths = [];
  for (const path of packageManifestPaths) {
    try {
      await readText(path);
      paths.push(path);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  const packageDirs = await readdir(resolve(workspaceRoot, "packages"), { withFileTypes: true }).catch(() => []);
  for (const dirent of packageDirs) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const manifestPath = `packages/${dirent.name}/package.json`;
    if (!paths.includes(manifestPath)) {
      try {
        await readText(manifestPath);
        paths.push(manifestPath);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }
  return paths;
}

async function readJson(path) {
  return JSON.parse(await readText(path));
}

async function readText(path) {
  return readFile(join(workspaceRoot, path), "utf8");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertJsonEqual(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), message);
}
