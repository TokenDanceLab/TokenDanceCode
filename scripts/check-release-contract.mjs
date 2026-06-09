import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const expectedVersion = "0.2.0-ts.0";
const publicPackages = [
  {
    key: "core",
    directory: "packages/core",
    name: "@tokendance/code-core",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exportEntry: { import: "./dist/index.js", types: "./dist/index.d.ts" }
  },
  {
    key: "sdk",
    directory: "packages/sdk",
    name: "@tokendance/code-sdk",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exportEntry: { import: "./dist/index.js", types: "./dist/index.d.ts" },
    dependency: ["@tokendance/code-core", "workspace:*"]
  },
  {
    key: "cli",
    directory: "packages/cli",
    name: "@tokendance/code-cli",
    main: "./dist/main.js",
    types: "./dist/main.d.ts",
    bin: { tokendance: "./dist/main.js" },
    dependency: ["@tokendance/code-sdk", "workspace:*"]
  }
];

await main();

async function main() {
  const rootPackage = await readJson("package.json");
  const failures = [];

  await collect(failures, "package manifest", () => assertPackageManifest(rootPackage));
  await collect(failures, "AgentHub contract readiness", () => assertAgentHubContractReadiness(rootPackage));
  await collect(failures, "pack smoke entrypoint", () => assertPackSmokeEntrypoint(rootPackage));

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    throw new Error(`release contract check failed with ${failures.length} issue(s)`);
  }

  console.log("Release contract check passed: package manifests, AgentHub contract readiness, and pack smoke entrypoint are aligned.");
}

async function collect(failures, label, check) {
  try {
    await check();
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function assertPackageManifest(rootPackage) {
  assert(rootPackage.private === true, "workspace root must stay private");
  assert(rootPackage.version === expectedVersion, `workspace version must be ${expectedVersion}`);
  assert(rootPackage.license === "MIT", "workspace license must be MIT");
  assert(rootPackage.scripts?.["contract:check"] === "node scripts/check-release-contract.mjs", "contract:check script drifted");
  assert(rootPackage.scripts?.["pack:smoke"] === "node scripts/smoke-tarball-install.mjs", "pack:smoke entrypoint drifted");
  assert(
    rootPackage.scripts?.["release:next:check"] === "pnpm contract:check && pnpm verify && pnpm pack:check",
    "release:next:check must explainably run contract, verify, then pack gates"
  );
  assertNoPublishScript(rootPackage);

  const license = await readText("LICENSE");
  assert(license.includes("MIT License"), "root LICENSE must keep MIT text");

  for (const pkg of publicPackages) {
    const manifest = await readJson(`${pkg.directory}/package.json`);
    const readme = await readText(`${pkg.directory}/README.md`);
    assert(manifest.private !== true, `${pkg.name} must not be private`);
    assert(manifest.name === pkg.name, `${pkg.directory}/package.json name drifted`);
    assert(manifest.version === rootPackage.version, `${pkg.name} version must match workspace`);
    assert(manifest.license === "MIT", `${pkg.name} license must be MIT`);
    assert(manifest.type === "module", `${pkg.name} must stay ESM`);
    assert(manifest.main === pkg.main, `${pkg.name} main entry drifted`);
    assert(manifest.types === pkg.types, `${pkg.name} types entry drifted`);
    assertJsonEqual(manifest.files, ["dist", "README.md"], `${pkg.name} files must only publish dist and README`);
    assertJsonEqual(manifest.publishConfig, { access: "public", tag: "next" }, `${pkg.name} publishConfig must stay public next`);
    assertJsonEqual(
      manifest.repository,
      { type: "git", url: "https://github.com/TokenDanceLab/TokenDanceCode.git", directory: pkg.directory },
      `${pkg.name} repository metadata drifted`
    );
    assert(manifest.homepage === "https://github.com/TokenDanceLab/TokenDanceCode#readme", `${pkg.name} homepage drifted`);
    assertJsonEqual(manifest.bugs, { url: "https://github.com/TokenDanceLab/TokenDanceCode/issues" }, `${pkg.name} bugs URL drifted`);
    assert(Array.isArray(manifest.keywords), `${pkg.name} keywords must be present`);
    for (const keyword of ["tokendance", "agenthub", "coding-agent"]) {
      assert(manifest.keywords.includes(keyword), `${pkg.name} missing keyword ${keyword}`);
    }
    if (pkg.exportEntry) {
      assertJsonEqual(manifest.exports?.["."], pkg.exportEntry, `${pkg.name} export entry drifted`);
    }
    if (pkg.bin) {
      assertJsonEqual(manifest.bin, pkg.bin, `${pkg.name} bin entry drifted`);
    }
    if (pkg.dependency) {
      assert(manifest.dependencies?.[pkg.dependency[0]] === pkg.dependency[1], `${pkg.name} workspace dependency drifted`);
    }
    assert(readme.includes(pkg.name), `${pkg.name} README must name the package`);
    assert(readme.includes("Manual approval gate"), `${pkg.name} README must document the release approval boundary`);
    assertNoPublishScript(manifest, pkg.name);
  }
}

async function assertAgentHubContractReadiness(rootPackage) {
  const packageInfo = await readText("packages/sdk/src/package-info.ts");
  const sdkIndex = await readText("packages/sdk/src/index.ts");
  const agentHubEvents = await readText("packages/sdk/src/agenthub-events.ts");
  const agentHubExamplePackage = await readJson("packages/agenthub-example/package.json");
  const agentHubExampleSource = await readText("packages/agenthub-example/src/index.ts");
  const agentHubExampleTests = await readText("packages/agenthub-example/tests/agenthub-runner.test.ts");

  assert(rootPackage.scripts?.build?.includes("packages/agenthub-example"), "build must include the private AgentHub example fixture");
  assert(rootPackage.scripts?.typecheck?.includes("packages/agenthub-example"), "typecheck must include the private AgentHub example fixture");
  assert(agentHubExamplePackage.private === true, "AgentHub example package must stay private");
  assert(agentHubExamplePackage.name === "@tokendance/code-agenthub-example", "AgentHub example package name drifted");
  assert(packageInfo.includes('AGENTHUB_SDK_CONTRACT_VERSION = "agenthub-sdk.v1"'), "SDK contract version constant drifted");
  assert(packageInfo.includes("AGENTHUB_AGENT_STREAM_SCHEMA_VERSION = 2"), "agent.stream schema version drifted");
  assert(packageInfo.includes('AGENTHUB_AGENT_STREAM_SOURCE = "tokendance-code-sdk"'), "agent.stream source drifted");
  for (const feature of [
    "event-envelope",
    "doctor-readiness",
    "runner-bootstrap",
    "agenthub-consumer-fixture",
    "session-lifecycle-metadata",
    "remote-approval",
    "tokendanceid-oidc-login",
    "config-validation"
  ]) {
    assert(packageInfo.includes(`"${feature}"`), `SDK manifest missing AgentHub feature ${feature}`);
  }
  for (const exportLine of [
    'export * from "./agenthub-events.js";',
    'export * from "./approval-bridge.js";',
    'export * from "./doctor.js";',
    'export * from "./package-info.js";',
    'export * from "./tokendance-id.js";'
  ]) {
    assert(sdkIndex.includes(exportLine), `SDK index missing ${exportLine}`);
  }
  for (const symbol of [
    "AgentHubAgentStreamPayload",
    "createAgentHubEventSink",
    "createAgentHubAgentStreamSink",
    "createAgentHubAgentStreamEmitter",
    "sdk_contract_version",
    "schema_version",
    "source_event_type",
    "event_seq",
    "run.agent.permission_requested",
    "run.agent.result"
  ]) {
    assert(agentHubEvents.includes(symbol), `AgentHub events contract missing ${symbol}`);
  }
  for (const typeName of [
    "AgentRunRecord",
    "TaskRecord",
    "TodoRecord",
    "ToolMetadata",
    "ToolResult",
    "WorktreeRecord"
  ]) {
    assert(new RegExp(`export type[\\s\\S]*\\b${typeName}\\b`).test(sdkIndex), `SDK index must re-export public facade type ${typeName}`);
  }
  for (const symbol of [
    "createAgentHubTokenDanceRunner",
    "createAgentHubTokenDanceConsumerFixture",
    "startup",
    "events",
    "approvals",
    "verifyLoginCallback"
  ]) {
    assert(agentHubExampleSource.includes(symbol), `AgentHub fixture source missing ${symbol}`);
  }
  for (const evidence of [
    "startup.doctor.agentHub.ready",
    "startup.packageInfo.agentHub.features",
    "agenthub-consumer-fixture",
    "edge-consumer-2",
    "consumer write ok",
    "approved by AgentHub consumer"
  ]) {
    assert(agentHubExampleTests.includes(evidence), `AgentHub fixture readiness test missing ${evidence}`);
  }
}

async function assertPackSmokeEntrypoint(rootPackage) {
  const smokeScript = await readText("scripts/smoke-tarball-install.mjs");
  assert(rootPackage.scripts?.["pack:dry-run"] === [
    "pnpm --filter @tokendance/code-core pack --dry-run",
    "pnpm --filter @tokendance/code-sdk pack --dry-run",
    "pnpm --filter @tokendance/code-cli pack --dry-run"
  ].join(" && "), "pack:dry-run must cover all public packages");
  assert(rootPackage.scripts?.["pack:check"] === "pnpm build && pnpm pack:dry-run && pnpm pack:smoke", "pack:check script drifted");
  for (const expected of [
    "@tokendance/code-core",
    "@tokendance/code-sdk",
    "@tokendance/code-cli",
    "pnpm",
    "pack",
    "--pack-destination",
    "TOKEN_DANCE_CODE_PACKAGE.verification.tarballSmoke !== 'pnpm pack:smoke'",
    "new TokenDanceCode()",
    "doctor --json",
    "quality --json",
    "agentHub.ready",
    "provider-ready",
    "TOKENDANCE_GATEWAY_API_KEY",
    "assertNoForbiddenPackageContent",
    "Packed package privacy scan failed",
    "npm_[A-Za-z0-9]{20,}"
  ]) {
    assert(smokeScript.includes(expected), `pack smoke script missing ${expected}`);
  }
  assert(!smokeScript.includes("npm publish"), "pack smoke script must not publish");
}

async function readJson(path) {
  return JSON.parse(await readText(path));
}

async function readText(path) {
  return readFile(resolve(workspaceRoot, path), "utf8");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertJsonEqual(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

function assertNoPublishScript(manifest, label = manifest.name ?? "workspace") {
  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    assert(!String(command).includes("npm publish"), `${label} script ${name} must not run npm publish`);
  }
}
