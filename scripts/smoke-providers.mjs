#!/usr/bin/env node
// Smoke test for Rust provider HTTP transports
// Requires explicit opt-in: TOKENDANCE_SMOKE_PROVIDERS=1
// Never reads .env files, never commits keys

import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TIMEOUT_MS = 30_000;

const PROVIDERS = [
  {
    name: "OpenAI Chat Completions",
    gate: "TOKENDANCE_GATEWAY_HTTP_TRANSPORT",
    key: "TOKENDANCE_GATEWAY_API_KEY",
    fallback_key: "OPENAI_API_KEY",
  },
  {
    name: "OpenAI Responses",
    gate: "TOKENDANCE_OPENAI_TRANSPORT",
    key: "TOKENDANCE_OPENAI_API_KEY",
    fallback_key: "OPENAI_API_KEY",
  },
  {
    name: "Anthropic Messages",
    gate: "TOKENDANCE_ANTHROPIC_TRANSPORT",
    key: "TOKENDANCE_ANTHROPIC_API_KEY",
    fallback_key: "ANTHROPIC_API_KEY",
  },
];

function redactOutput(text) {
  // Remove any key-like patterns from output before printing
  return text
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[redacted-key]")
    .replace(/tk-[A-Za-z0-9_-]{20,}/g, "[redacted-key]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}/g, "[redacted-token]")
    .replace(/npm_[A-Za-z0-9]{20,}/g, "[redacted-token]");
}

async function smokeTest() {
  if (process.env.TOKENDANCE_SMOKE_PROVIDERS !== "1") {
    console.error(
      "Provider smoke tests are opt-in.\n" +
      "Set TOKENDANCE_SMOKE_PROVIDERS=1 and per-provider gate env vars to run.\n" +
      "\n" +
      "Gates:\n" +
      "  TOKENDANCE_GATEWAY_HTTP_TRANSPORT=1  + TOKENDANCE_GATEWAY_API_KEY (or OPENAI_API_KEY)\n" +
      "  TOKENDANCE_OPENAI_TRANSPORT=1        + TOKENDANCE_OPENAI_API_KEY (or OPENAI_API_KEY)\n" +
      "  TOKENDANCE_ANTHROPIC_TRANSPORT=1     + TOKENDANCE_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY)"
    );
    process.exit(0);
  }

  console.log("Provider smoke tests\n" + "=".repeat(40));

  const results = [];

  for (const provider of PROVIDERS) {
    // Check gate env var
    if (process.env[provider.gate] !== "1") {
      console.log(`\n[SKIP] ${provider.name} — gate ${provider.gate} not set`);
      results.push({ name: provider.name, status: "skipped" });
      continue;
    }

    // Check key
    const key = process.env[provider.key] || process.env[provider.fallback_key];
    if (!key) {
      console.log(`\n[MISSING KEY] ${provider.name} — set ${provider.key} or ${provider.fallback_key}`);
      results.push({ name: provider.name, status: "missing_key" });
      continue;
    }

    // Run cargo test
    console.log(`\n[RUN] ${provider.name}...`);
    const start = Date.now();

    const result = spawnSync(
      "cargo", ["run", "-p", "tokendance-cli", "--", "run", "--json", "hello"],
      {
        cwd: workspaceRoot,
        timeout: TIMEOUT_MS,
        encoding: "utf8",
        env: {
          ...process.env,
          [provider.gate]: "1",
          // Ensure the key is passed through but we never print it
        },
        stdio: "pipe",
      }
    );

    const elapsed = Date.now() - start;

    if (result.error) {
      if (result.error.code === "ETIMEDOUT" || result.signal === "SIGTERM") {
        console.log(`[TIMEOUT] ${provider.name} — exceeded ${TIMEOUT_MS}ms`);
        results.push({ name: provider.name, status: "timeout" });
      } else {
        console.log(`[ERROR] ${provider.name} — ${result.error.message}`);
        results.push({ name: provider.name, status: "error" });
      }
      continue;
    }

    if (result.status !== 0) {
      const stderr = redactOutput(result.stderr || "");
      console.log(`[FAIL] ${provider.name} — exit code ${result.status} (${elapsed}ms)`);
      if (stderr) {
        console.log(`  stderr: ${stderr.split("\n").slice(0, 5).join("\n         ")}`);
      }
      results.push({ name: provider.name, status: "failed" });
      continue;
    }

    // Parse and validate JSON output
    const stdout = result.stdout || "";
    try {
      const parsed = JSON.parse(stdout);
      if (parsed.success === true || parsed.finalResponse) {
        console.log(`[PASS] ${provider.name} (${elapsed}ms)`);
        results.push({ name: provider.name, status: "passed" });
      } else {
        console.log(`[FAIL] ${provider.name} — unexpected JSON structure (${elapsed}ms)`);
        results.push({ name: provider.name, status: "failed" });
      }
    } catch {
      // Non-JSON output is still a pass if exit code is 0 and output is non-empty
      const redacted = redactOutput(stdout);
      if (stdout.trim().length > 0) {
        console.log(`[PASS] ${provider.name} — non-JSON output (${elapsed}ms)`);
        results.push({ name: provider.name, status: "passed" });
      } else {
        console.log(`[FAIL] ${provider.name} — empty output (${elapsed}ms)`);
        results.push({ name: provider.name, status: "failed" });
      }
    }
  }

  // Summary
  console.log("\n" + "=".repeat(40));
  console.log("Summary:\n");

  let configured = 0;
  let passed = 0;
  let failed = 0;

  for (const r of results) {
    if (r.status === "skipped") {
      console.log(`  SKIP   ${r.name}`);
    } else {
      configured++;
      if (r.status === "passed") {
        passed++;
        console.log(`  PASS   ${r.name}`);
      } else {
        failed++;
        console.log(`  FAIL   ${r.name} (${r.status})`);
      }
    }
  }

  console.log(`\nConfigured: ${configured} | Passed: ${passed} | Failed: ${failed}`);

  if (configured === 0) {
    console.log("\nNo providers were configured. Set gate env vars to run smoke tests.");
    process.exit(0);
  }

  process.exit(failed > 0 ? 1 : 0);
}

smokeTest().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
