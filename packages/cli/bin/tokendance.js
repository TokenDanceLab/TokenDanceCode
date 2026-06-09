#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const binName = process.platform === "win32" ? "tokendance.exe" : "tokendance";

const nativePackages = {
  "win32-x64": "@tokendance/code-cli-win32-x64-msvc",
  "darwin-arm64": "@tokendance/code-cli-darwin-arm64",
  "darwin-x64": "@tokendance/code-cli-darwin-x64",
  "linux-x64": "@tokendance/code-cli-linux-x64-gnu",
  "linux-arm64": "@tokendance/code-cli-linux-arm64-gnu"
};

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");
const localCandidates = [
  join(workspaceRoot, "target/release", binName),
  join(workspaceRoot, "target/debug", binName)
];

const platformKey = `${process.platform}-${process.arch}`;
const nativePackageName = nativePackages[platformKey];
const binary = resolveBinary();

if (!binary) {
  const packageHint = nativePackageName ?? "no native package is planned for this target yet";
  console.error(
    [
      `Unsupported platform for TokenDanceCode Rust CLI: ${platformKey}.`,
      `Expected a local built Rust binary at target/release/tokendance or target/debug/tokendance, or native package ${packageHint}.`,
      "Build locally with: cargo build -p tokendance-cli"
    ].join("\n")
  );
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });

if (result.error) {
  console.error(`Failed to start TokenDanceCode Rust CLI at ${binary}: ${result.error.message}`);
  process.exit(1);
}

if (result.signal) {
  console.error(`TokenDanceCode Rust CLI terminated by signal ${result.signal}.`);
  process.exit(1);
}

process.exit(result.status ?? 0);

function resolveBinary() {
  for (const candidate of localCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  if (!nativePackageName) {
    return null;
  }

  try {
    return require.resolve(`${nativePackageName}/bin/${binName}`);
  } catch {
    return null;
  }
}
