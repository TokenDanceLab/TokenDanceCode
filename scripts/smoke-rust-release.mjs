#!/usr/bin/env node
// Rust release readiness check
// Runs all gates and produces a report

import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TIMEOUT_MS = 120_000;

// Privacy scan patterns — same as smoke-rust-wrapper-tarball.mjs
const privacyPatterns = [
  { label: "Windows user path", pattern: /C:[\\/]+Users[\\/]+/i },
  { label: "local workspace path", pattern: /D:[\\/]+Code[\\/]+/i },
  { label: "OpenAI-style API key", pattern: /sk-[A-Za-z0-9_-]{20,}/ },
  { label: "GitHub token", pattern: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}/ },
  { label: "npm token", pattern: /npm_[A-Za-z0-9]{20,}/ },
  { label: "npm auth token config", pattern: /_authToken\s*=/i },
  { label: "provider API key assignment", pattern: /\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|TOKENDANCE_GATEWAY_API_KEY)\s*=\s*(?!<[^>\r\n]+>|your-|""|'')\S+/i },
  { label: "private key material", pattern: /BEGIN (?:RSA|OPENSSH|EC|PRIVATE) KEY/ },
];

const checks = [
  { name: "cargo fmt", cmd: "cargo", args: ["fmt", "--all", "--", "--check"] },
  { name: "cargo test", cmd: "cargo", args: ["test", "--workspace"], timeout: 180_000 },
  { name: "cargo clippy", cmd: "cargo", args: ["clippy", "--workspace", "--", "-D", "warnings"] },
  { name: "CLI --version", cmd: "cargo", args: ["run", "-p", "tokendance-cli", "--", "--version"] },
  { name: "CLI doctor", cmd: "cargo", args: ["run", "-p", "tokendance-cli", "--", "doctor", "--json"] },
  { name: "release plan check", cmd: "node", args: ["scripts/check-rust-release-plan.mjs"] },
  { name: "wrapper smoke", cmd: "node", args: ["scripts/smoke-rust-wrapper-tarball.mjs"], timeout: 180_000 },
  { name: "privacy scan", fn: "privacyScan" },
];

async function runCheck(check) {
  if (check.fn === "privacyScan") {
    return privacyScan();
  }

  const start = Date.now();
  const timeout = check.timeout || TIMEOUT_MS;

  const result = spawnSync(check.cmd, check.args, {
    cwd: workspaceRoot,
    timeout,
    encoding: "utf8",
    stdio: "pipe",
  });

  const elapsed = Date.now() - start;

  if (result.error) {
    const timedOut = result.error.code === "ETIMEDOUT" || result.signal === "SIGTERM";
    return {
      name: check.name,
      passed: false,
      detail: timedOut ? `timed out after ${timeout}ms` : result.error.message,
      elapsed,
    };
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const preview = stderr ? stderr.split("\n").slice(-5).join("\n  ") : "";
    return {
      name: check.name,
      passed: false,
      detail: `exit code ${result.status}${preview ? "\n  " + preview : ""}`,
      elapsed,
    };
  }

  return {
    name: check.name,
    passed: true,
    detail: (result.stdout || "").trim().split("\n").slice(-1)[0] || "",
    elapsed,
  };
}

async function privacyScan() {
  const start = Date.now();
  const findings = [];
  let scannedFiles = 0;

  // Directories to scan for public-facing files
  const scanDirs = [
    join(workspaceRoot, "docs"),
    join(workspaceRoot, "packages", "cli", "bin"),
    join(workspaceRoot, "scripts"),
  ];

  // Also scan root-level files
  const rootFiles = [
    "README.md",
    "package.json",
    "Cargo.toml",
  ];

  for (const file of rootFiles) {
    const filePath = join(workspaceRoot, file);
    try {
      const content = await readFile(filePath, "utf8");
      scannedFiles++;
      scanContent(content, filePath, findings);
    } catch {
      // File might not exist, skip
    }
  }

  for (const dir of scanDirs) {
    try {
      const files = await listFilesRecursive(dir);
      for (const filePath of files) {
        if (!isScannableFile(filePath)) continue;
        try {
          const content = await readFile(filePath, "utf8");
          scannedFiles++;
          scanContent(content, filePath, findings);
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // Directory might not exist
    }
  }

  const elapsed = Date.now() - start;

  if (findings.length > 0) {
    return {
      name: "privacy scan",
      passed: false,
      detail: `${findings.length} finding(s) in ${scannedFiles} files:\n  ` +
        findings.map((f) => `${f.label} in ${f.file}`).join("\n  "),
      elapsed,
    };
  }

  return {
    name: "privacy scan",
    passed: true,
    detail: `${scannedFiles} files scanned, no findings`,
    elapsed,
  };
}

function scanContent(content, filePath, findings) {
  for (const pattern of privacyPatterns) {
    if (pattern.pattern.test(content)) {
      findings.push({ label: pattern.label, file: filePath });
    }
  }
}

async function listFilesRecursive(root, visited = new Set()) {
  const { realpath } = await import("node:fs/promises");
  const { stat } = await import("node:fs/promises");
  const resolvedRoot = await realpath(root);
  if (visited.has(resolvedRoot)) return [];
  visited.add(resolvedRoot);

  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(path, visited));
    } else if (entry.isFile()) {
      files.push(path);
    } else if (entry.isSymbolicLink()) {
      const target = await stat(path).catch(() => undefined);
      if (target?.isFile()) files.push(path);
      else if (target?.isDirectory()) files.push(...await listFilesRecursive(path, visited));
    }
  }
  return files;
}

function isScannableFile(path) {
  return /\.(?:js|mjs|cjs|d\.ts|map|json|md|txt|toml)$/i.test(path);
}

async function checkReleaseReadiness() {
  console.log("Rust Release Readiness Check");
  console.log("=".repeat(50) + "\n");

  const results = [];

  for (const check of checks) {
    process.stdout.write(`  ${check.name}... `);
    const result = await runCheck(check);
    results.push(result);

    if (result.passed) {
      console.log(`PASS (${result.elapsed}ms)`);
    } else {
      console.log(`FAIL (${result.elapsed}ms)`);
    }
  }

  // Summary table
  console.log("\n" + "=".repeat(50));
  console.log("Results:\n");

  const labelWidth = Math.max(...results.map((r) => r.name.length)) + 2;
  let passed = 0;
  let failed = 0;

  for (const result of results) {
    const status = result.passed ? "PASS" : "FAIL";
    const icon = result.passed ? "+" : "X";
    console.log(`  [${icon}] ${result.name.padEnd(labelWidth)} ${status}`);
    if (result.detail && !result.passed) {
      for (const line of result.detail.split("\n")) {
        console.log(`      ${line}`);
      }
    }
    if (result.passed) passed++;
    else failed++;
  }

  console.log(`\nTotal: ${results.length} | Passed: ${passed} | Failed: ${failed}`);

  if (failed > 0) {
    console.log("\nRelease NOT ready. Fix the failing checks above.");
    process.exit(1);
  }

  console.log("\nAll checks passed. Release is ready for manual review.");
  process.exit(0);
}

checkReleaseReadiness().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
